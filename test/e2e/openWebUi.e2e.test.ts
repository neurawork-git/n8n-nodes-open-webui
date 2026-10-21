/**
 * E2E gegen einen echten Open-WebUI-Container (CI-Job `e2e-owui`, nur per
 * workflow_dispatch). Läuft über den n8n-freien Kern mit `fetch` als Transport.
 * Die Brücke zu n8n (`GenericFunctions` → `httpRequestWithAuthentication`)
 * prüft dieser Test nicht — das macht der CI-Job `n8n-execute` (test/n8n/).
 *
 * Konfiguration kommt als Jest-Global aus `jest.e2e.config.js`.
 */
import { sleep } from 'n8n-workflow';

import {
	chatComplete,
	createKnowledgeBase,
	downloadFile,
	getKnowledgeBase,
	listModels,
	removeFileFromKnowledge,
	searchKnowledge,
	uploadFile,
} from '../../nodes/OpenWebUi/operations';
import { OwuiClient, type OwuiHttpRequest, type OwuiHttpResponse } from '../../nodes/OpenWebUi/transport';

declare const OWUI_E2E: { baseUrl: string; apiKey: string; model: string };

const WAIT = { timeoutMs: 180_000, intervalMs: 2_000 };

async function fetchHttp(request: OwuiHttpRequest): Promise<OwuiHttpResponse> {
	const url = new URL(request.url);
	for (const [key, value] of Object.entries(request.qs ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	const headers: Record<string, string> = {
		Authorization: `Bearer ${OWUI_E2E.apiKey}`,
		...(request.headers ?? {}),
	};
	let body: Uint8Array | string | undefined;
	if (request.rawBody) body = new Uint8Array(request.rawBody);
	else if (request.body !== undefined) {
		body = JSON.stringify(request.body);
		headers['Content-Type'] = 'application/json';
	}
	const response = await fetch(url, { method: request.method, headers, body });
	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});
	if (request.binary) {
		return { status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) };
	}
	const text = await response.text();
	const isJson = (responseHeaders['content-type'] ?? '').includes('application/json');
	return { status: response.status, headers: responseHeaders, body: isJson && text ? JSON.parse(text) : text };
}

const client = new OwuiClient({
	baseUrl: OWUI_E2E.baseUrl,
	http: fetchHttp,
	sleep: async (ms: number) => await sleep(ms),
});

const CHECKS = {
	requireSources: 'auto' as const,
	parseJson: false,
	checkModel: true,
	includeRaw: false,
	timeoutMs: 120_000,
};

describe('Open WebUI E2E', () => {
	let knowledgeBaseId = '';
	let fileId = '';

	it('ist konfiguriert', () => {
		expect(OWUI_E2E.baseUrl).not.toBe('');
		expect(OWUI_E2E.apiKey).not.toBe('');
		expect(OWUI_E2E.model).not.toBe('');
	});

	it('sieht das Stub-Modell', async () => {
		const models = await listModels(client);
		expect(models.map((model) => model.id)).toContain(OWUI_E2E.model);
	});

	it('legt eine Wissensdatenbank an, lädt hoch, wartet und hängt an', async () => {
		knowledgeBaseId = (await createKnowledgeBase(client, `e2e-${Date.now()}`, 'E2E n8n-nodes-open-webui')).id;
		const upload = await uploadFile(
			client,
			{
				data: Buffer.from('Der Pflegegrad 3 bedeutet schwere Beeinträchtigung der Selbstständigkeit.'),
				filename: 'pflegegrad.txt',
				mimeType: 'text/plain',
			},
			{ wait: WAIT, knowledgeBaseId },
		);
		fileId = upload.id;
		expect(upload.status).toBe('completed');
		const knowledgeBase = await getKnowledgeBase(client, knowledgeBaseId);
		expect(knowledgeBase.files.map((file) => file.id)).toContain(fileId);
	});

	it('findet den Inhalt über die Suche', async () => {
		const hits = await searchKnowledge(client, knowledgeBaseId, 'Pflegegrad', 3);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].content).toMatch(/Pflegegrad/);
	});

	it('chattet mit der Wissensdatenbank und bekommt Quellen', async () => {
		const models = await listModels(client);
		const result = await chatComplete(
			client,
			models,
			{
				model: OWUI_E2E.model,
				systemPrompt: '',
				prompt: 'Was bedeutet Pflegegrad 3?',
				knowledgeBaseIds: [knowledgeBaseId],
				fileIds: [],
			},
			CHECKS,
		);
		expect(result.content).toMatch(/^STUB:/);
		expect(result.sources.length).toBeGreaterThan(0);
	});

	it('lädt die Datei unverändert herunter', async () => {
		const downloaded = await downloadFile(client, fileId);
		expect(downloaded.data.toString('utf8')).toMatch(/Pflegegrad 3/);
	});

	it('nimmt die Datei aus der Wissensdatenbank, ohne sie zu löschen', async () => {
		await removeFileFromKnowledge(client, knowledgeBaseId, fileId);
		const knowledgeBase = await getKnowledgeBase(client, knowledgeBaseId);
		expect(knowledgeBase.files.map((file) => file.id)).not.toContain(fileId);
		await expect(downloadFile(client, fileId)).resolves.toBeDefined();
	});
});
