// OpenAI-Stub für den E2E-Job: genug API, damit Open WebUI chatten und
// einbetten kann — ohne Netz, ohne Kosten, deterministisch.
//
//   node test/e2e/openai-stub.mjs 9999
//
// - GET  /v1/models            → ein Modell "stub-model"
// - POST /v1/chat/completions  → Antwort nennt das angefragte Modell und zitiert
//                                 den letzten Nutzertext (inkl. RAG-Kontext)
// - POST /v1/embeddings        → 16-dimensionale Vektoren aus Zeichenhäufigkeiten
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 9999);

function embed(text) {
	const vector = new Array(16).fill(0);
	for (const char of String(text).toLowerCase()) vector[char.charCodeAt(0) % 16] += 1;
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
	return vector.map((value) => value / norm);
}

function send(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		const body = raw ? JSON.parse(raw) : {};
		const path = (req.url ?? '').replace(/\?.*$/, '');
		if (req.method === 'GET' && path.endsWith('/models')) {
			return send(res, 200, { object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }] });
		}
		if (req.method === 'POST' && path.endsWith('/embeddings')) {
			const inputs = Array.isArray(body.input) ? body.input : [body.input];
			return send(res, 200, {
				object: 'list',
				model: body.model ?? 'stub-embedding',
				data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: embed(input) })),
				usage: { prompt_tokens: 1, total_tokens: 1 },
			});
		}
		if (req.method === 'POST' && path.endsWith('/chat/completions')) {
			if (body.stream) {
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'stub' } }] })}\n\n`);
				return res.end('data: [DONE]\n\n');
			}
			const last = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
			const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
			return send(res, 200, {
				id: 'chatcmpl-stub',
				object: 'chat.completion',
				created: Math.floor(Date.now() / 1000),
				model: body.model,
				choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `STUB: ${text.slice(0, 2000)}` } }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		return send(res, 404, { error: { message: `stub: ${req.method} ${path} unbekannt` } });
	});
}).listen(port, () => console.log(`openai-stub auf :${port}`));
