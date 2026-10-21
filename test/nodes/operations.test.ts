import {
	addFileToKnowledge,
	assertFilesReady,
	assertKnowledgeBasesVisible,
	buildChatBody,
	chatComplete,
	downloadFile,
	findModel,
	getKnowledgeBase,
	listKnowledgeBases,
	listModels,
	mapModels,
	mapSources,
	modelLabel,
	modelMatches,
	parseChatResponse,
	parseJsonObject,
	parseMessages,
	removeFileFromKnowledge,
	resolveModel,
	searchFiles,
	searchKnowledge,
	splitIds,
	substringPattern,
	toOptionalNumber,
	toRequireSources,
	toSeconds,
	toUploadInput,
	transcribe,
	uploadFile,
	waitForProcessing,
	type ChatChecks,
	type OwuiModel,
} from '../../nodes/OpenWebUi/operations';
import { OwuiCheckError, OwuiError } from '../../nodes/OpenWebUi/transport';
import { fakeClient, on, sequence } from '../helpers/fakeClient';

const RAW_MODELS = [
	{ id: 'low', name: 'low', owned_by: 'openai', connection_type: 'external' },
	{ id: 'medium', name: 'medium', owned_by: 'openai' },
	{
		id: 'beratungsauswerter',
		name: 'Beratungsauswerter',
		preset: true,
		info: {
			base_model_id: 'medium',
			meta: { description: 'Wertet Beratungen aus', knowledge: [{ id: 'kb1', name: 'Pflege', type: 'collection' }] },
		},
	},
	{ id: 'alt', name: 'Altes Preset', preset: true, info: { base_model_id: 'gpt-5.6-luna' } },
];

const MODELS = mapModels(RAW_MODELS);

const CHECKS: ChatChecks = {
	requireSources: 'auto',
	parseJson: false,
	checkModel: true,
	includeRaw: false,
	timeoutMs: 300_000,
};

const WAIT = { timeoutMs: 6_000, intervalMs: 2_000 };

describe('Modelle', () => {
	it('unterscheidet Base-Modelle und Presets und erkennt ein defektes Preset', () => {
		expect(MODELS.map((model) => [model.id, model.type, model.baseModelId, model.broken])).toEqual([
			['low', 'base', null, false],
			['medium', 'base', null, false],
			['beratungsauswerter', 'preset', 'medium', false],
			['alt', 'preset', 'gpt-5.6-luna', true],
		]);
		expect(MODELS[2].knowledge).toEqual([{ id: 'kb1', name: 'Pflege', type: 'collection' }]);
		expect(MODELS[2].description).toBe('Wertet Beratungen aus');
	});

	it('beschriftet die Auswahlliste wie geplant', () => {
		expect(MODELS.map(modelLabel)).toEqual([
			'Base · low',
			'Base · medium',
			'Preset · Beratungsauswerter (→ medium)',
			'⚠ defekt · Preset · Altes Preset (→ gpt-5.6-luna fehlt)',
		]);
	});

	it('listet über GET /api/models und wirft ohne data', async () => {
		const ok = fakeClient([on('GET', '/api/models', { body: { data: RAW_MODELS } })]);
		await expect(listModels(ok.client)).resolves.toHaveLength(4);
		const broken = fakeClient([on('GET', '/api/models', { body: { models: [] } })]);
		await expect(listModels(broken.client)).rejects.toThrow(/kein Feld data/);
	});

	it('nennt bei unbekanntem Modell die verfügbaren, statt zu raten', () => {
		expect(() => resolveModel(MODELS, 'gpt-5.6-luna')).toThrow(
			/gpt-5\.6-luna.*existiert nicht.*low, medium, beratungsauswerter, alt/s,
		);
	});

	it('wirft bei einem Preset, dessen Base-Modell fehlt', () => {
		expect(() => resolveModel(MODELS, 'alt')).toThrow(/Base-Modell „gpt-5\.6-luna“/);
	});

	it('erklärt eine leere Modellliste mit den Freigaben', () => {
		expect(() => resolveModel([], 'low')).toThrow(/überhaupt kein Modell.*freigegeben/s);
	});

	it('findModel liefert auch ein defektes Preset (für Model: Get)', () => {
		expect(findModel(MODELS, 'alt').broken).toBe(true);
		expect(() => findModel(MODELS, '')).toThrow(/kein Modell gewählt/);
	});
});

describe('Wissensdatenbanken', () => {
	const page = (from: number, count: number) =>
		Array.from({ length: count }, (_, index) => ({
			id: `kb${from + index}`,
			name: `KB ${from + index}`,
			file_count: index,
		}));

	it('liest alle Seiten, bis eine Seite weniger als 30 bringt', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/knowledge/', (request) =>
				request.qs?.page === 1
					? { body: { items: page(0, 30), total: 35 } }
					: { body: { items: page(30, 5), total: 35 } },
			),
		]);
		const all = await listKnowledgeBases(client);
		expect(all).toHaveLength(35);
		expect(all[1]).toMatchObject({ id: 'kb1', name: 'KB 1', fileCount: 1 });
		expect(requests.map((request) => request.qs?.page)).toEqual([1, 2]);
	});

	it('hört bei Erreichen von total auf, auch wenn die Seite voll ist', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/knowledge/', { body: { items: page(0, 30), total: 30 } }),
		]);
		await expect(listKnowledgeBases(client)).resolves.toHaveLength(30);
		expect(requests).toHaveLength(1);
	});

	it('wirft, wenn items fehlt, statt eine leere Liste zu liefern', async () => {
		const { client } = fakeClient([on('GET', '/api/v1/knowledge/', { body: { detail: 'x' } })]);
		await expect(listKnowledgeBases(client)).rejects.toThrow(/kein Feld items/);
	});

	it('holt die Dateien über /files, weil GET /knowledge/{id} files: null liefert', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/knowledge/kb1', { body: { id: 'kb1', name: 'Pflege', files: null } }),
			on('GET', '/api/v1/knowledge/kb1/files', {
				body: { items: [{ id: 'f1', filename: 'a.pdf', meta: { size: 3 } }], total: 1 },
			}),
		]);
		const knowledgeBase = await getKnowledgeBase(client, 'kb1');
		expect(knowledgeBase).toMatchObject({ id: 'kb1', name: 'Pflege' });
		expect(knowledgeBase.files).toEqual([
			expect.objectContaining({ id: 'f1', filename: 'a.pdf', meta: { size: 3 } }),
		]);
	});

	it('meldet eine nicht sichtbare Wissensdatenbank vor dem Chat', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/knowledge/geheim', {
				status: 401,
				body: { detail: 'You do not have permission to access this resource.' },
			}),
		]);
		const error = await assertKnowledgeBasesVisible(client, ['geheim']).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OwuiError);
		expect((error as OwuiError).message).toMatch(/401.*geheim.*ohne Fehlermeldung überspringen/s);
	});

	it('mappt die Suche auf Textstellen mit Score und sendet k nur, wenn positiv', async () => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/retrieval/query/collection', {
				body: {
					documents: [['Text A', 'Text B']],
					distances: [[0.9, 0.4]],
					metadatas: [[{ file_id: 'f1', name: 'a.pdf' }, { source: 'b.pdf' }]],
				},
			}),
		]);
		const hits = await searchKnowledge(client, 'kb1', 'Pflegegrad', 2);
		expect(hits).toEqual([
			{ content: 'Text A', score: 0.9, fileId: 'f1', name: 'a.pdf', metadata: { file_id: 'f1', name: 'a.pdf' } },
			{ content: 'Text B', score: 0.4, fileId: null, name: 'b.pdf', metadata: { source: 'b.pdf' } },
		]);
		expect(requests[0].body).toEqual({ collection_names: ['kb1'], query: 'Pflegegrad', k: 2 });

		await searchKnowledge(client, 'kb1', 'x', 0);
		expect(requests[1].body).toEqual({ collection_names: ['kb1'], query: 'x' });
	});

	it('lehnt eine leere Suchanfrage ab', async () => {
		const { client } = fakeClient([]);
		await expect(searchKnowledge(client, 'kb1', '  ', 5)).rejects.toThrow(OwuiCheckError);
	});

	it('sendet beim Entfernen immer delete_file=false', async () => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/knowledge/kb1/file/remove', { body: { name: 'Pflege' } }),
		]);
		await expect(removeFileFromKnowledge(client, 'kb1', 'f1')).resolves.toEqual({
			knowledgeBaseId: 'kb1',
			fileId: 'f1',
			knowledgeBaseName: 'Pflege',
		});
		expect(requests[0].qs).toEqual({ delete_file: false });
		expect(requests[0].body).toEqual({ file_id: 'f1' });
	});
});

describe('Dateien und Verarbeitung', () => {
	it('wartet, bis der Status completed ist', async () => {
		const { client, sleeps } = fakeClient([
			on(
				'GET',
				'/api/v1/files/f1/process/status',
				sequence({ body: { status: 'pending' } }, { body: { status: 'processing' } }, { body: { status: 'completed' } }),
			),
		]);
		await waitForProcessing(client, 'f1', WAIT);
		expect(sleeps).toEqual([2000, 2000]);
	});

	it('meldet failed mit dem Grund aus GET /files/{id}', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'failed' } }),
			on('GET', '/api/v1/files/f1', { body: { id: 'f1', data: { status: 'failed', error: 'Kein Text' } } }),
		]);
		await expect(waitForProcessing(client, 'f1', WAIT)).rejects.toThrow(/f1 nicht verarbeiten: Kein Text/);
	});

	it('bricht nach dem Timeout mit Datei-ID und Status ab', async () => {
		const { client, sleeps } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'pending' } }),
		]);
		await expect(waitForProcessing(client, 'f1', WAIT)).rejects.toThrow(/f1.*6 s.*pending/s);
		expect(sleeps).toEqual([2000, 2000, 2000]);
	});

	it('zählt die Dauer der Statusabfragen mit (Wanduhr) und begrenzt jede auf die Restzeit', async () => {
		const fake = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', () => {
				fake.tick(5_000);
				return { body: { status: 'pending' } };
			}),
		]);
		await expect(waitForProcessing(fake.client, 'f1', WAIT)).rejects.toThrow(/f1.*6 s.*pending/s);
		// 5 s Abfrage + 1 s Schlaf + 5 s Abfrage — nicht 3 × 2 s Schlaf plus Abfragen.
		expect(fake.sleeps).toEqual([1_000]);
		expect(fake.requests.map((request) => request.timeoutMs)).toEqual([6_000, 1_000]);
	});

	it('prüft das erste pending über GET /files/{id}, wenn nicht feststeht, dass die Datei einen Status trägt', async () => {
		const { client, sleeps } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'pending' } }),
			on('GET', '/api/v1/files/f1', { body: { id: 'f1', data: {} } }),
		]);
		await expect(waitForProcessing(client, 'f1', WAIT, false)).rejects.toThrow(
			/f1 hat keinen Verarbeitungsstatus/,
		);
		expect(sleeps).toEqual([]);
	});

	it('wirft bei unbekanntem Status, statt weiter zu warten', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'irgendwas' } }),
		]);
		await expect(waitForProcessing(client, 'f1', WAIT)).rejects.toThrow(/Unbekannter Verarbeitungsstatus/);
	});

	it('lädt hoch, wartet und hängt erst danach per file/add an', async () => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/files/', { body: { id: 'f9', filename: 'a.pdf', data: { status: 'pending' } } }),
			on('GET', '/api/v1/files/f9/process/status', sequence({ body: { status: 'pending' } }, { body: { status: 'completed' } })),
			on('POST', '/api/v1/knowledge/kb1/file/add', { body: { id: 'kb1', name: 'Pflege' } }),
		]);
		const result = await uploadFile(
			client,
			{ data: Buffer.from('%PDF'), filename: 'a.pdf', mimeType: 'application/pdf' },
			{ wait: WAIT, knowledgeBaseId: 'kb1' },
		);
		expect(result).toEqual({ id: 'f9', filename: 'a.pdf', status: 'completed', knowledgeBaseId: 'kb1' });
		expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
			'POST /api/v1/files/',
			'GET /api/v1/files/f9/process/status',
			'GET /api/v1/files/f9/process/status',
			'POST /api/v1/knowledge/kb1/file/add',
		]);
		// multipart von Hand: Content-Type mit Boundary, Datei-Part im Body.
		expect(requests[0].headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
		expect(requests[0].rawBody?.toString('utf8')).toMatch(
			/name="file"; filename="a\.pdf"\r\nContent-Type: application\/pdf\r\n\r\n%PDF\r\n/,
		);
		// Kein metadata.knowledge_id: dort meldet OWUI fehlende Rechte nur im Log.
		expect(requests[0].rawBody?.toString('utf8')).not.toMatch(/knowledge_id/);
	});

	it('lädt ohne Warten hoch und meldet den Status pending', async () => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/files/', { body: { id: 'f9', filename: 'a.pdf', data: { status: 'pending' } } }),
		]);
		const result = await uploadFile(
			client,
			{ data: Buffer.from('x'), filename: 'a.pdf', mimeType: 'application/pdf' },
			{ wait: null },
		);
		expect(result.status).toBe('pending');
		expect(requests).toHaveLength(1);
	});

	it('erfindet keinen Status, wenn die Upload-Antwort keinen trägt', async () => {
		const { client } = fakeClient([on('POST', '/api/v1/files/', { body: { id: 'f9', filename: 'a.pdf' } })]);
		const result = await uploadFile(
			client,
			{ data: Buffer.from('x'), filename: 'a.pdf', mimeType: 'application/pdf' },
			{ wait: null },
		);
		expect(result.status).toBeNull();
	});

	it('verlangt beim Upload mit Wissensdatenbank das Warten — vor jedem Request', async () => {
		const { client, requests } = fakeClient([]);
		await expect(
			uploadFile(
				client,
				{ data: Buffer.from('x'), filename: 'a.pdf', mimeType: 'application/pdf' },
				{ wait: null, knowledgeBaseId: 'kb1' },
			),
		).rejects.toThrow(/muss auf die Verarbeitung gewartet werden/);
		expect(requests).toHaveLength(0);
	});

	it.each([
		['failed', { body: { status: 'failed' } }, /f9 nicht verarbeiten: Kein Text/],
		['Timeout', { body: { status: 'processing' } }, /f9.*noch nicht verarbeitet/s],
	])('Upload mit Wissensdatenbank: bei %s kein file/add', async (_case, status, message) => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/files/', { body: { id: 'f9', filename: 'a.pdf', data: { status: 'pending' } } }),
			on('GET', '/api/v1/files/f9/process/status', status),
			on('GET', '/api/v1/files/f9', { body: { id: 'f9', data: { status: 'failed', error: 'Kein Text' } } }),
			on('POST', '/api/v1/knowledge/kb1/file/add', { body: { name: 'Pflege' } }),
		]);
		await expect(
			uploadFile(
				client,
				{ data: Buffer.from('%PDF'), filename: 'a.pdf', mimeType: 'application/pdf' },
				{ wait: WAIT, knowledgeBaseId: 'kb1' },
			),
		).rejects.toThrow(message);
		expect(requests.some((request) => request.path.endsWith('/file/add'))).toBe(false);
	});

	it('Add File ohne Warten wirft vor file/add, wenn die Datei nicht fertig ist', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'pending' } }),
			on('GET', '/api/v1/files/f1', { body: { id: 'f1', data: { status: 'pending' } } }),
		]);
		await expect(addFileToKnowledge(client, 'kb1', 'f1', null)).rejects.toThrow(/„pending“.*failed/s);
		expect(requests.some((request) => request.path.endsWith('/file/add'))).toBe(false);
	});

	it('Add File mit Warten ruft file/add erst nach completed', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', sequence({ body: { status: 'processing' } }, { body: { status: 'completed' } })),
			on('POST', '/api/v1/knowledge/kb1/file/add', { body: { name: 'Pflege' } }),
		]);
		await expect(addFileToKnowledge(client, 'kb1', 'f1', WAIT)).resolves.toMatchObject({
			knowledgeBaseName: 'Pflege',
		});
		expect(requests[requests.length - 1].body).toEqual({ file_id: 'f1' });
	});

	it('Add File: Datei ohne Status und ohne Inhalt ist sofort ein Fehler, kein Warten bis zum Timeout', async () => {
		const { client, requests, sleeps } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'pending' } }),
			on('GET', '/api/v1/files/f1', { body: { id: 'f1', data: {} } }),
		]);
		await expect(addFileToKnowledge(client, 'kb1', 'f1', WAIT)).rejects.toThrow(
			/keinen Verarbeitungsstatus.*process=false oder Altdatei/s,
		);
		expect(sleeps).toEqual([]);
		expect(requests.some((request) => request.path.endsWith('/file/add'))).toBe(false);
	});

	it('Add File: Altdatei ohne Status, aber mit extrahiertem Inhalt geht direkt an file/add', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'pending' } }),
			on('GET', '/api/v1/files/f1', { body: { id: 'f1', data: { content: 'Text aus der Altdatei' } } }),
			on('POST', '/api/v1/knowledge/kb1/file/add', { body: { name: 'Pflege' } }),
		]);
		await expect(addFileToKnowledge(client, 'kb1', 'f1', null)).resolves.toMatchObject({ fileId: 'f1' });
		expect(requests[requests.length - 1].path).toBe('/api/v1/knowledge/kb1/file/add');
	});

	it('behandelt die 404 „No files found“ der Dateisuche als leere Liste', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/files/search', { status: 404, body: { detail: 'No files found matching the pattern.' } }),
		]);
		await expect(searchFiles(client, '*.pdf', 100)).resolves.toEqual([]);
	});

	it('lässt jede andere 404 der Dateisuche ein Fehler bleiben', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/files/search', { status: 404, body: { detail: 'Not Found' } }),
		]);
		await expect(searchFiles(client, '*.pdf', 100)).rejects.toThrow(OwuiError);
	});

	it('sucht ohne Volltext und liefert Status, ohne data.content', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/search', {
				body: [{ id: 'f1', filename: 'a.pdf', data: { status: 'completed', content: 'GROSS' }, meta: { name: 'a.pdf', content_type: 'application/pdf', size: 4, data: { x: 1 } } }],
			}),
		]);
		const [file] = await searchFiles(client, '*a*', 10);
		expect(file).toMatchObject({ id: 'f1', status: 'completed', contentType: 'application/pdf', size: 4 });
		expect(JSON.stringify(file)).not.toMatch(/GROSS/);
		expect(file.meta).not.toHaveProperty('data');
		expect(requests[0].qs).toEqual({ filename: '*a*', content: false, limit: 10 });
	});

	it('baut für die Teilsuche ein Glob, lässt vorhandene Platzhalter aber stehen', () => {
		expect(substringPattern('Protokoll')).toBe('*Protokoll*');
		expect(substringPattern('*.pdf')).toBe('*.pdf');
		expect(substringPattern('')).toBe('*');
	});

	it('lädt die Originaldatei als Buffer mit MIME-Type aus den Metadaten', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/f1', { body: { id: 'f1', filename: 'v.pdf', meta: { content_type: 'application/pdf' } } }),
			on('GET', '/api/v1/files/f1/content', { body: Buffer.from('%PDF-1.7'), headers: { 'Content-Type': 'application/pdf' } }),
		]);
		const downloaded = await downloadFile(client, 'f1');
		expect(downloaded.data.toString()).toBe('%PDF-1.7');
		expect(downloaded.mimeType).toBe('application/pdf');
		expect(downloaded.file.filename).toBe('v.pdf');
		expect(requests[1].binary).toBe(true);
	});

	it('verlangt Dateiname und MIME-Type der Binärdaten', () => {
		expect(() => toUploadInput('data', Buffer.from('x'), { mimeType: 'audio/wav' })).toThrow(/keinen Dateinamen/);
		expect(() => toUploadInput('data', Buffer.from('x'), { fileName: 'a.wav' })).toThrow(/MIME-Type/);
		expect(toUploadInput('data', Buffer.from('x'), { fileName: 'a.wav', fileNameOverride: 'b.wav', mimeType: 'audio/wav' }).filename).toBe('b.wav');
	});
});

describe('Audio', () => {
	it('schickt die Datei mit dem MIME-Type des Binärfelds und die Sprache', async () => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/audio/transcriptions', { body: { text: 'Hallo', filename: 'x.wav' } }),
		]);
		await expect(
			transcribe(client, { data: Buffer.from('RIFF'), filename: 'a.wav', mimeType: 'audio/wav' }, 'de'),
		).resolves.toEqual({ text: 'Hallo', filename: 'x.wav' });
		const body = requests[0].rawBody?.toString('utf8') ?? '';
		expect(body).toMatch(/filename="a\.wav"\r\nContent-Type: audio\/wav/);
		expect(body).toMatch(/name="language"\r\n\r\nde\r\n/);
	});

	it('lässt die Sprache weg, wenn sie leer ist', async () => {
		const { client, requests } = fakeClient([
			on('POST', '/api/v1/audio/transcriptions', { body: { text: '' } }),
		]);
		await transcribe(client, { data: Buffer.from('x'), filename: 'a.wav', mimeType: 'audio/wav' }, '');
		expect(requests[0].rawBody?.toString('utf8')).not.toMatch(/language/);
	});

	it('nennt bei falschem MIME-Type die Ursache', async () => {
		const { client } = fakeClient([
			on('POST', '/api/v1/audio/transcriptions', { status: 400, body: { detail: 'File type not supported' } }),
		]);
		await expect(
			transcribe(client, { data: Buffer.from('x'), filename: 'a.wav', mimeType: 'application/octet-stream' }, ''),
		).rejects.toThrow(/MIME-Type/);
	});
});

describe('Chat', () => {
	const requested: OwuiModel = MODELS[2];
	const context = { requested, knowledgeBaseIds: ['kb1'], fileIds: [] };
	const ok = (body: Record<string, unknown>) => ({ status: 200, headers: { 'content-type': 'application/json' }, body });

	it('baut den Body mit Systemprompt, files und stream:false — ohne chat_id', () => {
		const body = buildChatBody({
			model: 'low',
			systemPrompt: 'Sei knapp.',
			prompt: 'Hallo',
			knowledgeBaseIds: ['kb1'],
			fileIds: ['f1'],
			temperature: 0.2,
			responseFormat: { type: 'json_object' },
		});
		expect(body).toEqual({
			model: 'low',
			messages: [
				{ role: 'system', content: 'Sei knapp.' },
				{ role: 'user', content: 'Hallo' },
			],
			stream: false,
			files: [
				{ type: 'collection', id: 'kb1' },
				{ type: 'file', id: 'f1' },
			],
			temperature: 0.2,
			response_format: { type: 'json_object' },
		});
		expect(body).not.toHaveProperty('chat_id');
		expect(body).not.toHaveProperty('session_id');
	});

	it('lässt files weg, wenn nichts gewählt ist', () => {
		const body = buildChatBody({ model: 'low', systemPrompt: '', prompt: 'x', knowledgeBaseIds: [], fileIds: [] });
		expect(body).not.toHaveProperty('files');
		expect(body.messages).toEqual([{ role: 'user', content: 'x' }]);
	});

	it('lehnt einen leeren Prompt ab', () => {
		expect(() => buildChatBody({ model: 'low', systemPrompt: '', prompt: ' ', knowledgeBaseIds: [], fileIds: [] })).toThrow(/Prompt ist leer/);
	});

	it('prüft Messages-JSON', () => {
		expect(parseMessages('[{"role":"user","content":"a"}]')).toEqual([{ role: 'user', content: 'a' }]);
		expect(() => parseMessages('[')).toThrow(/kein gültiges JSON/);
		expect(() => parseMessages('[]')).toThrow(/nicht leeres Array/);
		expect(() => parseMessages([{ content: 'a' }])).toThrow(/Messages\[0\]/);
	});

	it('trennt Datei-IDs an Komma, Semikolon und Leerraum', () => {
		expect(splitIds('a, b;c\nd')).toEqual(['a', 'b', 'c', 'd']);
		expect(splitIds(['x', ' y '])).toEqual(['x', 'y']);
		expect(splitIds('')).toEqual([]);
	});

	it('liefert content, model, usage und Quellen aus metadata', () => {
		const result = parseChatResponse(
			ok({
				model: 'medium',
				choices: [{ message: { content: 'Antwort' } }],
				usage: { total_tokens: 7 },
				sources: [
					{
						source: { type: 'collection', id: 'kb1', name: 'Pflege' },
						document: ['…', '…'],
						metadata: [
							{ file_id: 'f1', name: 'a.pdf' },
							{ file_id: 'f1', name: 'a.pdf' },
							{ file_id: 'f2', source: 'b.pdf' },
						],
					},
				],
			}),
			context,
			CHECKS,
		);
		expect(result).toEqual({
			content: 'Antwort',
			model: 'medium',
			usage: { total_tokens: 7 },
			sources: [
				{ name: 'a.pdf', id: 'f1', knowledgeBaseId: 'kb1' },
				{ name: 'b.pdf', id: 'f2', knowledgeBaseId: 'kb1' },
			],
		});
	});

	it('meldet SSE statt JSON mit Hinweis auf stream_response', () => {
		expect(() =>
			parseChatResponse(
				{ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {"sources":[]}' },
				context,
				CHECKS,
			),
		).toThrow(/SSE.*stream_response.*beratungsauswerter/s);
	});

	it('wirft, wenn das Modell der Antwort weder Preset noch Base-Modell ist', () => {
		const response = ok({ model: 'gpt-4o', choices: [{ message: { content: 'x' } }], sources: [{ source: { name: 'a' } }] });
		expect(() => parseChatResponse(response, context, CHECKS)).toThrow(/gpt-4o.*beratungsauswerter.*medium/s);
		expect(parseChatResponse(response, context, { ...CHECKS, checkModel: false }).model).toBe('gpt-4o');
	});

	it('akzeptiert die Modell-ID ohne prefix_id der Verbindung, aber keinen Snapshot-Namen', () => {
		const [prefixed] = mapModels([{ id: 'azure.gpt-4o', name: 'gpt-4o' }]);
		expect(modelMatches('gpt-4o', prefixed)).toBe(true);
		expect(modelMatches('azure.gpt-4o', prefixed)).toBe(true);
		expect(modelMatches('gpt-4o-2024-08-06', prefixed)).toBe(false);
		expect(modelMatches('4o', prefixed)).toBe(false);
		expect(modelMatches(null, prefixed)).toBe(false);
		const response = ok({ model: 'gpt-4o-2024-08-06', choices: [{ message: { content: 'x' } }] });
		const checks = { ...CHECKS, requireSources: 'never' as const };
		expect(() =>
			parseChatResponse(response, { requested: prefixed, knowledgeBaseIds: [], fileIds: [] }, checks),
		).toThrow(/gpt-4o-2024-08-06.*Modell Abgleichen/s);
		expect(
			parseChatResponse(
				response,
				{ requested: prefixed, knowledgeBaseIds: [], fileIds: [] },
				{ ...checks, checkModel: false },
			).model,
		).toBe('gpt-4o-2024-08-06');
	});

	it('verlangt Quellen auch bei Datei-IDs ohne Wissensdatenbank (Automatisch)', () => {
		const response = ok({ model: 'medium', choices: [{ message: { content: 'x' } }] });
		expect(() =>
			parseChatResponse(response, { requested, knowledgeBaseIds: [], fileIds: ['f1'] }, CHECKS),
		).toThrow(/keine Quellen.*f1/s);
	});

	it('verlangt Quellen bei gewählter Wissensdatenbank (Automatisch)', () => {
		const response = ok({ model: 'medium', choices: [{ message: { content: 'x' } }] });
		expect(() => parseChatResponse(response, context, CHECKS)).toThrow(/keine Quellen.*kb1/s);
		expect(parseChatResponse(response, { ...context, knowledgeBaseIds: [] }, CHECKS).sources).toEqual([]);
		expect(() =>
			parseChatResponse(response, { ...context, knowledgeBaseIds: [] }, { ...CHECKS, requireSources: 'always' }),
		).toThrow(/keine Quellen/);
		expect(parseChatResponse(response, context, { ...CHECKS, requireSources: 'never' }).content).toBe('x');
	});

	it('parst JSON auf Wunsch und nennt bei Fehler die ersten 500 Zeichen', () => {
		const checks = { ...CHECKS, requireSources: 'never' as const, parseJson: true };
		expect(
			parseChatResponse(ok({ model: 'medium', choices: [{ message: { content: '{"a":1}' } }] }), context, checks).json,
		).toEqual({ a: 1 });
		const long = `kein json ${'x'.repeat(600)}`;
		expect(() =>
			parseChatResponse(ok({ model: 'medium', choices: [{ message: { content: long } }] }), context, checks),
		).toThrow(/kein gültiges JSON.*Erste 500 Zeichen: kein json x+…$/s);
	});

	it('gibt die Rohantwort nur auf Wunsch mit', () => {
		const body = { model: 'medium', choices: [{ message: { content: 'x' } }] };
		const checks = { ...CHECKS, requireSources: 'never' as const };
		expect(parseChatResponse(ok(body), context, checks)).not.toHaveProperty('raw');
		expect(parseChatResponse(ok(body), context, { ...checks, includeRaw: true }).raw).toEqual(body);
	});

	it('wirft ohne choices[0].message.content', () => {
		expect(() => parseChatResponse(ok({ model: 'medium', choices: [] }), context, CHECKS)).toThrow(/ohne choices/);
	});

	it('mappt Quellen ohne metadata auf das Request-Item', () => {
		expect(mapSources([{ source: { type: 'file', id: 'f1', name: 'a.pdf' } }])).toEqual([
			{ name: 'a.pdf', id: 'f1', knowledgeBaseId: null },
		]);
		expect(mapSources(undefined)).toEqual([]);
	});

	it('prüft Modell und Wissensdatenbank vor dem Chat und sendet mit Timeout', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/knowledge/kb1', { body: { id: 'kb1' } }),
			on('POST', '/api/chat/completions', ok({ model: 'medium', choices: [{ message: { content: 'ok' } }], sources: [{ source: { id: 'kb1', name: 'Pflege', type: 'collection' } }] })),
		]);
		const result = await chatComplete(
			client,
			MODELS,
			{ model: 'beratungsauswerter', systemPrompt: '', prompt: 'Hallo', knowledgeBaseIds: ['kb1'], fileIds: [] },
			CHECKS,
		);
		expect(result.content).toBe('ok');
		expect(requests.map((request) => request.path)).toEqual(['/api/v1/knowledge/kb1', '/api/chat/completions']);
		expect(requests[1].timeoutMs).toBe(300_000);
	});

	it('prüft Datei-IDs vor dem Chat: sichtbar und fertig verarbeitet', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/f1/process/status', { body: { status: 'completed' } }),
			on('GET', '/api/v1/files/geheim/process/status', { status: 404, body: { detail: 'Not found' } }),
			on('GET', '/api/v1/files/f2/process/status', { body: { status: 'processing' } }),
		]);
		await expect(assertFilesReady(client, ['f1'])).resolves.toBeUndefined();

		const hidden = await assertFilesReady(client, ['geheim']).catch((caught: unknown) => caught);
		expect(hidden).toBeInstanceOf(OwuiError);
		expect((hidden as OwuiError).message).toMatch(/404.*geheim.*ohne Fehlermeldung überspringen/s);

		await expect(assertFilesReady(client, ['f2'])).rejects.toThrow(/f2.*„processing“/);
		expect(requests.every((request) => request.path !== '/api/chat/completions')).toBe(true);
	});

	it('ruft den Chat nicht auf, wenn eine Datei noch verarbeitet wird', async () => {
		const { client, requests } = fakeClient([
			on('GET', '/api/v1/files/f2/process/status', { body: { status: 'processing' } }),
		]);
		await expect(
			chatComplete(client, MODELS, { model: 'low', systemPrompt: '', prompt: 'x', knowledgeBaseIds: [], fileIds: ['f2'] }, CHECKS),
		).rejects.toThrow(OwuiCheckError);
		expect(requests.map((request) => request.path)).toEqual(['/api/v1/files/f2/process/status']);
	});

	it('ruft den Chat nicht auf, wenn die Modellprüfung scheitert', async () => {
		const { client, requests } = fakeClient([]);
		await expect(
			chatComplete(client, MODELS, { model: 'gpt-5.6-luna', systemPrompt: '', prompt: 'x', knowledgeBaseIds: [], fileIds: [] }, CHECKS),
		).rejects.toThrow(/existiert nicht/);
		expect(requests).toHaveLength(0);
	});
});

describe('parseJsonObject', () => {
	it('akzeptiert String und Objekt, leer heißt undefined', () => {
		expect(parseJsonObject('{"type":"json_object"}', 'X')).toEqual({ type: 'json_object' });
		expect(parseJsonObject({ a: 1 }, 'X')).toEqual({ a: 1 });
		expect(parseJsonObject('{}', 'X')).toBeUndefined();
		expect(parseJsonObject('', 'X')).toBeUndefined();
	});

	it('wirft bei kaputtem JSON oder Array', () => {
		expect(() => parseJsonObject('{', 'Antwortformat')).toThrow(/Antwortformat: kein gültiges JSON/);
		expect(() => parseJsonObject('[1]', 'Antwortformat')).toThrow(/JSON-Objekt/);
	});
});

describe('Optionen', () => {
	it('lässt für Quellen Erforderlich nur auto, always und never zu', () => {
		expect(toRequireSources(undefined)).toBe('auto');
		expect(toRequireSources('never')).toBe('never');
		expect(() => toRequireSources(true)).toThrow(/auto, always oder never.*true/);
		expect(() => toRequireSources('')).toThrow(OwuiCheckError);
	});

	it('nimmt Sekunden als Zahl oder Text, Default nur bei fehlendem Feld', () => {
		expect(toSeconds(undefined, 'Timeout in Sekunden', 300)).toBe(300);
		expect(toSeconds(600, 'Timeout in Sekunden', 300)).toBe(600);
		expect(toSeconds('600', 'Timeout in Sekunden', 300)).toBe(600);
		expect(() => toSeconds('abc', 'Timeout in Sekunden', 300)).toThrow(/Timeout in Sekunden.*größer 0/);
		expect(() => toSeconds(0, 'X', 300)).toThrow(OwuiCheckError);
		expect(() => toSeconds('', 'X', 300)).toThrow(OwuiCheckError);
		expect(() => toSeconds(null, 'X', 300)).toThrow(OwuiCheckError);
	});

	it('prüft optionale Zahlen statt sie still zu verwerfen', () => {
		expect(toOptionalNumber(undefined, 'Temperatur')).toBeUndefined();
		expect(toOptionalNumber('0.2', 'Temperatur')).toBe(0.2);
		expect(() => toOptionalNumber('warm', 'Temperatur')).toThrow(/Temperatur.*Zahl/);
	});
});
