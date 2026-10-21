// Wertet den CI-Job „n8n führt die Node aus“ aus.
//
//   node test/n8n/check-run.mjs run-output.txt stub-requests.json
//
// run-output.txt ist die Ausgabe von `n8n execute --rawOutput`; davor können
// Logzeilen stehen, das JSON beginnt mit der ersten Zeile, die mit `{` anfängt.
import { readFileSync } from 'node:fs';

const [outputFile, stubFile] = process.argv.slice(2);
const failures = [];
const expect = (condition, message) => {
	if (!condition) failures.push(message);
};

const output = readFileSync(outputFile, 'utf8');
const lines = output.split('\n');
const start = lines.findIndex((line) => line.startsWith('{'));
if (start === -1) {
	console.error(output);
	console.error('::error::Keine JSON-Ausgabe von n8n execute gefunden');
	process.exit(1);
}
const run = JSON.parse(lines.slice(start).join('\n'));
const runData = run?.data?.resultData?.runData ?? {};
const first = (node) => runData[node]?.[0]?.data?.main?.[0]?.[0];

const download = first('Download');
expect(download?.json?.id === 'src', `Download: json.id ist ${JSON.stringify(download?.json?.id)}`);
expect(download?.binary?.data?.mimeType === 'application/pdf', `Download: MIME-Type ${JSON.stringify(download?.binary?.data?.mimeType)}`);
expect(download?.binary?.data?.fileName === 'quelle.pdf', `Download: Dateiname ${JSON.stringify(download?.binary?.data?.fileName)}`);

const upload = first('Upload');
expect(upload?.json?.id === 'up1', `Upload: json ${JSON.stringify(upload?.json)}`);
expect(upload?.json?.status === 'pending', `Upload: Status ${JSON.stringify(upload?.json?.status)}`);

const chat = first('Chat');
expect(chat?.json?.status === 400, `Chat: Status ${JSON.stringify(chat?.json?.status)} statt 400`);
expect(chat?.json?.detail === 'Model not found', `Chat: detail ${JSON.stringify(chat?.json?.detail)}`);
expect(chat?.json?.endpoint === 'POST /api/chat/completions', `Chat: endpoint ${JSON.stringify(chat?.json?.endpoint)}`);

const requests = JSON.parse(readFileSync(stubFile, 'utf8'));
expect(requests.length > 0, 'Stub hat keine Anfrage gesehen');
expect(requests.every((r) => r.authorized), 'Mindestens eine Anfrage ohne Bearer-Key aus der Credential');
expect(!requests.some((r) => r.unexpected), `Unerwartete Anfragen: ${JSON.stringify(requests.filter((r) => r.unexpected))}`);
const uploads = requests.filter((r) => r.method === 'POST' && r.path === '/api/v1/files/');
expect(uploads.length === 1, `Upload ${uploads.length}-mal statt einmal`);
const multipart = uploads[0]?.multipart ?? {};
expect(multipart.fileHeader && multipart.bytesIntact && multipart.boundaryInBody, `multipart: ${JSON.stringify(multipart)}`);
const chats = requests.filter((r) => r.path === '/api/chat/completions');
expect(chats.length === 1, `Chat ${chats.length}-mal aufgerufen — kein eigener Retry erlaubt`);

console.log(JSON.stringify({ download: download?.json, upload: upload?.json, chat: chat?.json }, null, 2));
console.log(JSON.stringify(requests, null, 2));
if (failures.length > 0) {
	for (const failure of failures) console.error(`::error::${failure}`);
	process.exit(1);
}
console.log('n8n-Ausführung: alle Prüfungen bestanden.');
