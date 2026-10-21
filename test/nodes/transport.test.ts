import {
	OwuiCheckError,
	OwuiClient,
	OwuiError,
	buildMultipart,
	extractDetail,
} from '../../nodes/OpenWebUi/transport';
import { fakeClient, on } from '../helpers/fakeClient';

describe('OwuiClient', () => {
	it('kürzt die Basis-URL und hängt den Pfad an', async () => {
		const { client, requests } = fakeClient([on('GET', '/api/models', { body: { data: [] } })]);
		await client.get('/api/models');
		expect(requests[0].url).toBe('http://owui.test/api/models');
	});

	it('lässt undefinierte Query-Werte weg', async () => {
		const { client, requests } = fakeClient([on('GET', '/x', { body: {} })]);
		await client.get('/x', { a: 1, b: undefined });
		expect(requests[0].qs).toEqual({ a: 1 });
	});

	it('lehnt eine Basis-URL ohne Schema ab, statt zu raten', () => {
		expect(() => fakeClientWithBase('open-webui:8080')).toThrow(OwuiCheckError);
		expect(() => fakeClientWithBase('')).toThrow(/Base URL/);
	});

	it('wirft bei jeder Nicht-2xx-Antwort einen OwuiError mit Status, detail und Pfad', async () => {
		const { client } = fakeClient([
			on('GET', '/api/v1/knowledge/kb1', { status: 404, body: { detail: 'We could not find' } }),
		]);
		const error = await client.get('/api/v1/knowledge/kb1').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OwuiError);
		expect(error).toMatchObject({ status: 404, detail: 'We could not find', path: '/api/v1/knowledge/kb1' });
		expect((error as OwuiError).message).toMatch(/404 bei GET \/api\/v1\/knowledge\/kb1/);
	});

	it('unterscheidet bei "Model not found" unbekannt (400) und fehlende Freigabe (403)', async () => {
		const unknown = fakeClient([
			on('POST', '/api/chat/completions', { status: 400, body: { detail: 'Model not found' } }),
		]);
		await expect(unknown.client.post('/api/chat/completions', {})).rejects.toThrow(
			/kennt das Modell nicht/,
		);
		const denied = fakeClient([
			on('POST', '/api/chat/completions', { status: 403, body: { detail: 'Model not found' } }),
		]);
		await expect(denied.client.post('/api/chat/completions', {})).rejects.toThrow(
			/fehlt die Freigabe.*Base-Modell/s,
		);
	});

	it('sendet bei 5xx und 429 genau eine Anfrage und schläft nicht (kein eigener Retry)', async () => {
		for (const status of [500, 429]) {
			const { client, requests, sleeps } = fakeClient([
				on('POST', '/api/chat/completions', { status, body: { detail: 'kaputt' } }),
			]);
			await expect(client.post('/api/chat/completions', {})).rejects.toThrow(OwuiError);
			expect(requests).toHaveLength(1);
			expect(sleeps).toEqual([]);
		}
	});

	it('macht aus einem Timeout ohne Antwort einen Fehler mit Endpunkt, Dauer und Hinweis', async () => {
		const timeout = Object.assign(new Error('timeout of 300000ms exceeded'), { code: 'ECONNABORTED' });
		const client = new OwuiClient({
			baseUrl: 'http://owui.test',
			http: async () => {
				throw timeout;
			},
			sleep: async () => undefined,
		});
		const error = await client
			.request({ method: 'POST', path: '/api/chat/completions', body: {}, timeoutMs: 300_000 })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OwuiCheckError);
		expect((error as Error).message).toMatch(
			/POST \/api\/chat\/completions nach 300 s.*„Timeout in Sekunden“/s,
		);
		expect((error as Error).cause).toBe(timeout);
	});

	it('nennt bei Netzwerkfehlern Endpunkt und Code', async () => {
		const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:8080'), { code: 'ECONNREFUSED' });
		const client = new OwuiClient({
			baseUrl: 'http://owui.test',
			http: async () => {
				throw refused;
			},
			sleep: async () => undefined,
		});
		await expect(client.get('/api/models')).rejects.toThrow(
			/Keine Antwort von GET \/api\/models: connect ECONNREFUSED.*Base URL/s,
		);
	});

	it('benennt abgeschaltete API-Keys bei 403', async () => {
		const { client } = fakeClient([
			on('GET', '/api/models', {
				status: 403,
				body: { detail: 'Use of API key is not enabled in the environment.' },
			}),
		]);
		await expect(client.get('/api/models')).rejects.toThrow(/features\.api_keys/);
	});
});

describe('extractDetail', () => {
	it('liest detail als Text', () => {
		expect(extractDetail({ detail: 'kaputt' })).toBe('kaputt');
	});

	it('liest das 422-Array von FastAPI', () => {
		expect(
			extractDetail({ detail: [{ loc: ['body', 'file_id'], msg: 'field required', type: 'missing' }] }),
		).toBe('body.file_id: field required');
	});

	it('liest JSON aus einem Buffer (Fehler beim Download)', () => {
		expect(extractDetail(Buffer.from('{"detail":"nicht da"}'))).toBe('nicht da');
	});

	it('kürzt Text ohne JSON auf 500 Zeichen', () => {
		expect(extractDetail('x'.repeat(600))).toHaveLength(501);
	});

	it('meldet eine leere Antwort ausdrücklich', () => {
		expect(extractDetail(undefined)).toBe('(leere Antwort)');
	});
});

describe('buildMultipart', () => {
	it('baut Felder und Datei-Parts mit Boundary', () => {
		const { body, contentType } = buildMultipart(
			[
				{ name: 'file', value: { data: Buffer.from('abc'), filename: 'a"b.wav', contentType: 'audio/wav' } },
				{ name: 'language', value: 'de' },
			],
			'BOUNDARY',
		);
		expect(contentType).toBe('multipart/form-data; boundary=BOUNDARY');
		expect(body.toString('utf8')).toBe(
			'--BOUNDARY\r\n' +
				'Content-Disposition: form-data; name="file"; filename="a%22b.wav"\r\n' +
				'Content-Type: audio/wav\r\n\r\n' +
				'abc\r\n' +
				'--BOUNDARY\r\n' +
				'Content-Disposition: form-data; name="language"\r\n\r\n' +
				'de\r\n' +
				'--BOUNDARY--\r\n',
		);
	});

	it('erzeugt ohne Vorgabe eine zufällige Boundary', () => {
		const first = buildMultipart([{ name: 'a', value: 'b' }]).contentType;
		const second = buildMultipart([{ name: 'a', value: 'b' }]).contentType;
		expect(first).not.toBe(second);
	});
});

describe('Kern frei von n8n', () => {
	const forbidN8n = () =>
		jest.doMock('n8n-workflow', () => {
			throw new Error('Der Kern darf n8n-workflow nicht importieren');
		});

	it('transport lädt ohne n8n-workflow', async () => {
		await jest.isolateModulesAsync(async () => {
			forbidN8n();
			await expect(import('../../nodes/OpenWebUi/transport')).resolves.toBeDefined();
		});
	});

	it('operations lädt ohne n8n-workflow', async () => {
		await jest.isolateModulesAsync(async () => {
			forbidN8n();
			await expect(import('../../nodes/OpenWebUi/operations')).resolves.toBeDefined();
		});
	});

	it('die Probe schlägt wirklich an, wenn n8n-workflow importiert wird', async () => {
		await jest.isolateModulesAsync(async () => {
			forbidN8n();
			await expect(import('../../nodes/OpenWebUi/GenericFunctions')).rejects.toThrow(
				/nicht importieren/,
			);
		});
	});
});

function fakeClientWithBase(baseUrl: string): OwuiClient {
	return new OwuiClient({
		baseUrl,
		http: async () => ({ status: 200, body: null, headers: {} }),
		sleep: async () => undefined,
	});
}
