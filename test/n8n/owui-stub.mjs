// Open-WebUI-Stub für den CI-Job „n8n führt die Node aus“.
//
//   node test/n8n/owui-stub.mjs 8099 stub-requests.json
//
// Prüft genau das, was nur die echte n8n-Brücke (GenericFunctions →
// httpRequestWithAuthentication) zeigen kann: Bearer-Header aus der Credential,
// multipart-Body als Buffer, Binär-Download, Durchreichen eines 4xx-Status.
// Jede Anfrage wird mit Befund in die Datei aus argv[3] geschrieben; die
// Auswertung macht test/n8n/check-run.mjs.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

const port = Number(process.argv[2] ?? 8099);
const logFile = process.argv[3] ?? 'stub-requests.json';
const API_KEY = 'ci-n8n-key';

// Bytes, die eine UTF-8- oder JSON-Umwandlung nicht unbeschadet übersteht.
const SOURCE_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a, 0xc3, 0x28, 0x7f]);

const log = [];
function record(entry) {
	log.push(entry);
	writeFileSync(logFile, JSON.stringify(log, null, 2));
}

function send(res, status, body, headers = { 'content-type': 'application/json' }) {
	res.writeHead(status, headers);
	res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const raw = Buffer.concat(chunks);
		const path = (req.url ?? '').split('?')[0];
		const entry = {
			method: req.method,
			path,
			authorized: req.headers.authorization === `Bearer ${API_KEY}`,
		};

		// Bereitschaftsprobe der CI — wird nicht protokolliert.
		if (path === '/__health') return send(res, 200, { ok: true });

		if (!entry.authorized) {
			record(entry);
			return send(res, 401, { detail: 'Not authenticated' });
		}

		if (req.method === 'GET' && path === '/api/v1/files/src') {
			record(entry);
			return send(res, 200, {
				id: 'src',
				filename: 'quelle.pdf',
				data: { status: 'completed' },
				meta: { name: 'quelle.pdf', content_type: 'application/pdf', size: SOURCE_BYTES.length },
			});
		}
		if (req.method === 'GET' && path === '/api/v1/files/src/content') {
			record(entry);
			return send(res, 200, SOURCE_BYTES, { 'content-type': 'application/pdf' });
		}
		if (req.method === 'POST' && path === '/api/v1/files/') {
			const contentType = String(req.headers['content-type'] ?? '');
			const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
			entry.multipart = {
				contentType,
				boundaryInBody: boundary ? raw.includes(Buffer.from(`--${boundary}--`)) : false,
				fileHeader: raw.includes(
					Buffer.from('name="file"; filename="quelle.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),
				),
				bytesIntact: raw.includes(SOURCE_BYTES),
				size: raw.length,
			};
			record(entry);
			const ok = entry.multipart.boundaryInBody && entry.multipart.fileHeader && entry.multipart.bytesIntact;
			if (!ok) return send(res, 400, { detail: `multipart kaputt: ${JSON.stringify(entry.multipart)}` });
			return send(res, 200, { id: 'up1', filename: 'quelle.pdf', data: { status: 'pending' } });
		}
		if (req.method === 'GET' && path === '/api/models') {
			record(entry);
			return send(res, 200, { data: [{ id: 'stub-model', name: 'stub-model' }] });
		}
		if (req.method === 'POST' && path === '/api/chat/completions') {
			record(entry);
			return send(res, 400, { detail: 'Model not found' });
		}

		entry.unexpected = true;
		record(entry);
		return send(res, 404, { detail: `Stub kennt ${req.method} ${path} nicht` });
	});
}).listen(port, () => console.log(`owui-stub auf :${port}`));
