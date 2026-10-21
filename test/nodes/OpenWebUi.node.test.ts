import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import { OpenWebUi } from '../../nodes/OpenWebUi/OpenWebUi.node';
import {
	callTo,
	calls,
	mockExecuteFunctions,
	type MockResponse,
	type RequestOptions,
} from '../helpers/mockExecute';

const base = new OpenWebUi();

const MODELS: MockResponse = {
	statusCode: 200,
	body: {
		data: [
			{ id: 'low', name: 'low' },
			{ id: 'medium', name: 'medium' },
			{ id: 'beratungsauswerter', name: 'Beratungsauswerter', preset: true, info: { base_model_id: 'medium' } },
		],
	},
};

const chatParameters = (overrides: Record<string, unknown> = {}) => ({
	resource: 'chat',
	operation: 'complete',
	model: { mode: 'list', value: 'low' },
	inputMode: 'prompt',
	prompt: 'Hallo',
	systemPrompt: '',
	knowledgeBaseIds: ['kb1'],
	fileIds: '',
	chatOptions: {},
	...overrides,
});

function chatRoutes(chat: MockResponse) {
	return (_credential: string, options: RequestOptions): MockResponse => {
		if (options.url.endsWith('/api/models')) return MODELS;
		if (options.url.endsWith('/api/v1/knowledge/kb1')) return { statusCode: 200, body: { id: 'kb1', name: 'Pflege' } };
		if (options.url.endsWith('/api/chat/completions')) return chat;
		throw new Error(`Unerwartete Anfrage ${options.url}`);
	};
}

const CHAT_OK: MockResponse = {
	statusCode: 200,
	headers: { 'content-type': 'application/json' },
	body: {
		model: 'low',
		choices: [{ message: { content: 'ok' } }],
		usage: { total_tokens: 3 },
		sources: [{ source: { type: 'collection', id: 'kb1', name: 'Pflege' }, metadata: [{ file_id: 'f1', name: 'a.pdf' }] }],
	},
};

describe('Chat: Complete', () => {
	it('hängt die Wissensdatenbank als files an und prüft Modell und KB vorher', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters(),
			httpResponse: chatRoutes(CHAT_OK),
		});

		const [items] = await base.execute.call(context);

		expect(items).toEqual([
			{
				json: {
					content: 'ok',
					model: 'low',
					usage: { total_tokens: 3 },
					sources: [{ name: 'a.pdf', id: 'f1', knowledgeBaseId: 'kb1' }],
				},
				pairedItem: { item: 0 },
			},
		]);
		expect(calls(context).map(([, options]) => options.url)).toEqual([
			'http://open-webui.test/api/models',
			'http://open-webui.test/api/v1/knowledge/kb1',
			'http://open-webui.test/api/chat/completions',
		]);
		const [credential, chat] = calls(context)[2];
		expect(credential).toBe('openWebUiApi');
		// Ohne ignoreHttpStatusErrors landet die Fehlerübersetzung des Kerns nie.
		expect(chat).toMatchObject({
			method: 'POST',
			ignoreHttpStatusErrors: true,
			returnFullResponse: true,
			timeout: 300_000,
			body: { model: 'low', stream: false, files: [{ type: 'collection', id: 'kb1' }] },
		});
	});

	it('fragt /api/models nur einmal pro Ausführung ab, auch bei mehreren Items', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [] }),
			items: [{ json: {} }, { json: {} }],
			httpResponse: chatRoutes({ ...CHAT_OK, body: { model: 'low', choices: [{ message: { content: 'ok' } }] } }),
		});
		const [items] = await base.execute.call(context);
		expect(items.map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
		expect(calls(context).filter(([, options]) => options.url.endsWith('/api/models'))).toHaveLength(1);
	});

	it('wirft bei unbekanntem Modell mit Liste der verfügbaren, statt zu raten', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ model: { mode: 'id', value: 'gpt-5.6-luna' } }),
			httpResponse: MODELS,
		});
		const error = await base.execute.call(context).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NodeOperationError);
		expect((error as Error).message).toMatch(/gpt-5\.6-luna.*existiert nicht.*low, medium, beratungsauswerter/s);
		// Kein Chat-Aufruf nach gescheiterter Prüfung.
		expect(context.__httpMock).toHaveBeenCalledTimes(1);
	});

	it('meldet SSE statt JSON mit Hinweis auf stream_response', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [] }),
			httpResponse: chatRoutes({
				statusCode: 200,
				headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
				body: 'data: {"sources":[]}\n\n',
			}),
		});
		await expect(base.execute.call(context)).rejects.toThrow(/stream_response/);
	});

	it('macht aus einer OWUI-Fehlerantwort einen NodeApiError mit Status, detail und Endpunkt', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [] }),
			httpResponse: chatRoutes({ statusCode: 400, body: { detail: 'Rate limit reached' } }),
		});
		const error = await base.execute.call(context).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).httpCode).toBe('400');
		expect((error as Error).message).toMatch(/400 bei POST \/api\/chat\/completions: Rate limit reached/);
		// Kein eigener Retry — Wiederholen ist Sache von n8ns „Retry on Fail“.
		expect(calls(context).filter(([, options]) => options.url.endsWith('/api/chat/completions'))).toHaveLength(1);
	});

	it('verarbeitet bei continueOnFail nach einem Fehler-Item die übrigen weiter', async () => {
		let chats = 0;
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [] }),
			items: [{ json: {} }, { json: {} }, { json: {} }],
			continueOnFail: true,
			httpResponse: (_credential, options) => {
				if (options.url.endsWith('/api/models')) return MODELS;
				if (options.url.endsWith('/api/chat/completions')) {
					chats++;
					return chats === 2
						? { statusCode: 400, body: { detail: 'Rate limit reached' } }
						: { statusCode: 200, body: { model: 'low', choices: [{ message: { content: `ok${chats}` } }] } };
				}
				throw new Error(`Unerwartete Anfrage ${options.url}`);
			},
		});
		const [items] = await base.execute.call(context);
		expect(items).toEqual([
			{ json: expect.objectContaining({ content: 'ok1' }), pairedItem: { item: 0 } },
			{
				json: expect.objectContaining({
					error: expect.stringMatching(/Rate limit reached/),
					status: 400,
					detail: 'Rate limit reached',
					endpoint: 'POST /api/chat/completions',
				}),
				pairedItem: { item: 1 },
			},
			{ json: expect.objectContaining({ content: 'ok3' }), pairedItem: { item: 2 } },
		]);
	});

	it('nimmt den Timeout auch als Text aus einem Ausdruck und lehnt Unsinn ab', async () => {
		const ok = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [], chatOptions: { timeout: '600' } }),
			httpResponse: chatRoutes({ statusCode: 200, body: { model: 'low', choices: [{ message: { content: 'x' } }] } }),
		});
		await base.execute.call(ok);
		expect(callTo(ok, '/api/chat/completions')?.timeout).toBe(600_000);

		for (const chatOptions of [{ timeout: 'lang' }, { requireSources: true }, { temperature: 'warm' }]) {
			const context = mockExecuteFunctions({
				nodeParameters: chatParameters({ knowledgeBaseIds: [], chatOptions }),
				httpResponse: MODELS,
			});
			await expect(base.execute.call(context)).rejects.toThrow(NodeOperationError);
			expect(callTo(context, '/api/chat/completions')).toBeUndefined();
		}
	});

	it('gleicht das Modell standardmäßig nicht ab (Anbieter melden Deployment-Namen)', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [] }),
			httpResponse: chatRoutes({ statusCode: 200, body: { model: 'gpt-6-luna-2026-09-01', choices: [{ message: { content: 'x' } }] } }),
		});
		const [items] = await base.execute.call(context);
		expect(items[0].json.model).toBe('gpt-6-luna-2026-09-01');
	});

	it('liefert bei continueOnFail { error } pro Item statt abzubrechen', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({ knowledgeBaseIds: [] }),
			continueOnFail: true,
			httpResponse: chatRoutes({ statusCode: 400, body: { detail: 'Model not found' } }),
		});
		const [items] = await base.execute.call(context);
		expect(items).toEqual([
			{
				json: expect.objectContaining({
					error: expect.stringMatching(/Model not found/),
					status: 400,
					detail: 'Model not found',
					endpoint: 'POST /api/chat/completions',
				}),
				pairedItem: { item: 0 },
			},
		]);
	});

	it('reicht Systemprompt, Temperatur und Antwortformat weiter und parst JSON', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: chatParameters({
				knowledgeBaseIds: [],
				systemPrompt: 'Nur JSON.',
				chatOptions: { temperature: 0.1, responseFormat: '{"type":"json_object"}', parseJson: true, timeout: 30 },
			}),
			httpResponse: chatRoutes({ statusCode: 200, body: { model: 'low', choices: [{ message: { content: '{"a":1}' } }] } }),
		});
		const [items] = await base.execute.call(context);
		expect(items[0].json.json).toEqual({ a: 1 });
		expect(callTo(context, '/api/chat/completions')).toMatchObject({
			timeout: 30_000,
			body: {
				temperature: 0.1,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: 'Nur JSON.' },
					{ role: 'user', content: 'Hallo' },
				],
			},
		});
	});
});

describe('Model', () => {
	it('Get Many filtert auf Presets', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: { resource: 'model', operation: 'getMany', modelType: 'preset' },
			httpResponse: MODELS,
		});
		const [items] = await base.execute.call(context);
		expect(items.map((item) => item.json.id)).toEqual(['beratungsauswerter']);
		expect(items[0].json).toMatchObject({ type: 'preset', baseModelId: 'medium', broken: false });
	});

	it('Get liefert das Preset samt Base-Modell', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: { resource: 'model', operation: 'get', model: { mode: 'id', value: 'beratungsauswerter' } },
			httpResponse: MODELS,
		});
		const [items] = await base.execute.call(context);
		expect(items[0].json).toMatchObject({ id: 'beratungsauswerter', baseModelId: 'medium' });
	});
});

describe('File', () => {
	afterEach(() => jest.useRealTimers());

	it('Upload wartet mit n8n-sleep auf completed und hängt dann an die Wissensdatenbank', async () => {
		jest.useFakeTimers();
		let statusCalls = 0;
		const context = mockExecuteFunctions({
			nodeParameters: {
				resource: 'file',
				operation: 'upload',
				binaryPropertyName: 'data',
				fileName: '',
				uploadKnowledgeBaseId: 'kb1',
				waitForProcessing: true,
				waitOptions: { interval: 1, timeout: 10 },
			},
			binaryData: { fileName: 'protokoll.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
			httpResponse: (_credential, options) => {
				if (options.url.endsWith('/api/v1/files/')) {
					return { statusCode: 200, body: { id: 'f1', filename: 'protokoll.pdf', data: { status: 'pending' } } };
				}
				if (options.url.endsWith('/process/status')) {
					statusCalls++;
					return { statusCode: 200, body: { status: statusCalls < 3 ? 'pending' : 'completed' } };
				}
				if (options.url.endsWith('/api/v1/knowledge/kb1/file/add')) {
					return { statusCode: 200, body: { id: 'kb1', name: 'Pflege' } };
				}
				throw new Error(`Unerwartete Anfrage ${options.url}`);
			},
		});

		const running = base.execute.call(context);
		await jest.advanceTimersByTimeAsync(5_000);
		const [items] = await running;

		expect(items[0].json).toEqual({
			id: 'f1',
			filename: 'protokoll.pdf',
			status: 'completed',
			knowledgeBaseId: 'kb1',
		});
		expect(statusCalls).toBe(3);
		const upload = callTo(context, '/api/v1/files/');
		expect(upload?.headers?.['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
		expect(Buffer.isBuffer(upload?.body)).toBe(true);
		expect(callTo(context, '/file/add')?.body).toEqual({ file_id: 'f1' });
	});

	it('Upload bricht nach dem Timeout mit der Datei-ID ab', async () => {
		jest.useFakeTimers();
		const context = mockExecuteFunctions({
			nodeParameters: {
				resource: 'file',
				operation: 'upload',
				binaryPropertyName: 'data',
				uploadKnowledgeBaseId: '',
				waitForProcessing: true,
				waitOptions: { interval: 1, timeout: 2 },
			},
			binaryData: { fileName: 'a.pdf', mimeType: 'application/pdf' },
			httpResponse: (_credential, options) =>
				options.url.endsWith('/api/v1/files/')
					? { statusCode: 200, body: { id: 'f7', data: { status: 'pending' } } }
					: { statusCode: 200, body: { status: 'pending' } },
		});
		const running = base.execute.call(context).catch((caught: unknown) => caught);
		await jest.advanceTimersByTimeAsync(5_000);
		expect(((await running) as Error).message).toMatch(/f7.*noch nicht verarbeitet/s);
	});

	it('Upload mit Wissensdatenbank ohne Warten ist ein Fehler, kein stilles Warten', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: {
				resource: 'file',
				operation: 'upload',
				binaryPropertyName: 'data',
				fileName: '',
				uploadKnowledgeBaseId: 'kb1',
				waitForProcessing: false,
			},
			binaryData: { fileName: 'a.pdf', mimeType: 'application/pdf' },
		});
		await expect(base.execute.call(context)).rejects.toThrow(/muss auf die Verarbeitung gewartet werden/);
		expect(context.__httpMock).not.toHaveBeenCalled();
	});

	it('Download schreibt die Datei ins Binärfeld', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: {
				resource: 'file',
				operation: 'download',
				fileId: { mode: 'id', value: 'f1' },
				binaryPropertyName: 'pdf',
			},
			httpResponse: (_credential, options) =>
				options.url.endsWith('/content')
					? { statusCode: 200, body: Buffer.from('%PDF'), headers: { 'content-type': 'application/pdf' } }
					: { statusCode: 200, body: { id: 'f1', filename: 'vorlage.pdf', meta: { content_type: 'application/pdf' } } },
		});
		const [items] = await base.execute.call(context);
		expect(items[0].binary?.pdf).toEqual({
			data: Buffer.from('%PDF').toString('base64'),
			fileName: 'vorlage.pdf',
			mimeType: 'application/pdf',
		});
		expect(callTo(context, '/content')).toMatchObject({ encoding: 'arraybuffer', json: false });
	});

	it('Get Many liefert bei „No files found“ keine Items statt eines Fehlers', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: { resource: 'file', operation: 'getMany', filenamePattern: '*.docx', maxResults: 100 },
			httpResponse: { statusCode: 404, body: { detail: 'No files found matching the pattern.' } },
		});
		const [items] = await base.execute.call(context);
		expect(items).toEqual([]);
	});
});

describe('Audio: Transcribe', () => {
	it('schickt die Binärdaten als multipart und liefert den Text', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: { resource: 'audio', operation: 'transcribe', binaryPropertyName: 'data', language: 'de' },
			binaryData: { fileName: 'gespraech.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF') },
			httpResponse: { statusCode: 200, body: { text: 'Guten Tag', filename: 'x.wav' } },
		});
		const [items] = await base.execute.call(context);
		expect(items[0].json).toEqual({ text: 'Guten Tag', filename: 'x.wav' });
		const request = callTo(context, '/api/v1/audio/transcriptions');
		expect(String(request?.body)).toMatch(/filename="gespraech\.wav"\r\nContent-Type: audio\/wav/);
	});
});

describe('Knowledge', () => {
	it('Remove File nimmt die Datei nur aus der Wissensdatenbank', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: {
				resource: 'knowledge',
				operation: 'removeFile',
				knowledgeBaseId: 'kb1',
				fileId: { mode: 'list', value: 'f1' },
			},
			httpResponse: { statusCode: 200, body: { id: 'kb1', name: 'Pflege' } },
		});
		await base.execute.call(context);
		expect(callTo(context, '/file/remove')?.qs).toEqual({ delete_file: false });
	});

	it('Search liefert ein Item mit allen Treffern', async () => {
		const context = mockExecuteFunctions({
			nodeParameters: { resource: 'knowledge', operation: 'search', knowledgeBaseId: 'kb1', query: 'Pflegegrad', topK: 3 },
			httpResponse: { statusCode: 200, body: { documents: [['A']], distances: [[0.8]], metadatas: [[{ file_id: 'f1', name: 'a.pdf' }]] } },
		});
		const [items] = await base.execute.call(context);
		expect(items).toHaveLength(1);
		expect(items[0].json).toMatchObject({ knowledgeBaseId: 'kb1', query: 'Pflegegrad', results: [{ content: 'A', score: 0.8 }] });
	});
});
