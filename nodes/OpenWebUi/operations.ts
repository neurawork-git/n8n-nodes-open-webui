/**
 * Fachlogik gegen die Open-WebUI-API — wie `transport.ts` ohne n8n.
 *
 * Jede Funktion bekommt einen `OwuiClient` und liefert schlichte Objekte. Die
 * Node-Hülle sammelt nur Parameter ein und wandelt das Ergebnis in Items.
 * Die API-Belege (Pfad:Zeile im Fork 0.11.4-nw.2) stehen in `docs/OWUI_API.md`.
 */

import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	OwuiCheckError,
	OwuiClient,
	OwuiError,
	buildMultipart,
	extractDetail,
	isSuccess,
	parseJson,
	segment,
	toOwuiError,
	truncate,
	type MultipartPart,
} from './transport';

// ================================================================ Modelle

export type ModelType = 'base' | 'preset';

export interface KnowledgeRef {
	id: string;
	name: string;
	type: string;
}

export interface OwuiModel {
	id: string;
	name: string;
	type: ModelType;
	/** Bei Presets das Modell, auf dem es aufsetzt; bei Base-Modellen `null`. */
	baseModelId: string | null;
	/** Preset, dessen Base-Modell für den Key nicht (mehr) sichtbar ist. */
	broken: boolean;
	ownedBy: string | null;
	connectionType: string | null;
	description: string | null;
	knowledge: KnowledgeRef[];
}

interface RawModel {
	id?: unknown;
	name?: unknown;
	preset?: unknown;
	owned_by?: unknown;
	connection_type?: unknown;
	info?: {
		base_model_id?: unknown;
		name?: unknown;
		meta?: { description?: unknown; knowledge?: unknown };
	} | null;
}

/**
 * `GET /api/models` → Modelle und Presets, die der Key sieht.
 *
 * Ein Preset bleibt in der Liste, auch wenn sein Base-Modell fehlt — OWUI
 * setzt dann nur `owned_by` auf `openai`. Erkennbar ist es allein über
 * `info.base_model_id` gegen die IDs der Liste; genau das macht `broken`.
 */
export async function listModels(client: OwuiClient): Promise<OwuiModel[]> {
	const body = await client.get<{ data?: unknown }>('/api/models');
	if (!body || !Array.isArray(body.data)) {
		throw new OwuiCheckError(
			`GET /api/models lieferte kein Feld data: ${truncate(JSON.stringify(body ?? null), 500)}`,
		);
	}
	return mapModels(body.data as RawModel[]);
}

export function mapModels(raw: RawModel[]): OwuiModel[] {
	const ids = new Set(raw.map((model) => String(model.id)));
	return raw.map((model) => {
		const baseModelId =
			typeof model.info?.base_model_id === 'string' && model.info.base_model_id !== ''
				? model.info.base_model_id
				: null;
		const type: ModelType = baseModelId !== null || model.preset === true ? 'preset' : 'base';
		return {
			id: String(model.id),
			name: String(model.name ?? model.info?.name ?? model.id),
			type,
			baseModelId,
			broken: type === 'preset' && (baseModelId === null || !ids.has(baseModelId)),
			ownedBy: typeof model.owned_by === 'string' ? model.owned_by : null,
			connectionType: typeof model.connection_type === 'string' ? model.connection_type : null,
			description:
				typeof model.info?.meta?.description === 'string' ? model.info.meta.description : null,
			knowledge: mapKnowledgeRefs(model.info?.meta?.knowledge),
		};
	});
}

function mapKnowledgeRefs(raw: unknown): KnowledgeRef[] {
	if (!Array.isArray(raw)) return [];
	return raw.map((entry) => {
		const item = entry as { id?: unknown; name?: unknown; type?: unknown; collection_name?: unknown };
		return {
			id: String(item.id ?? item.collection_name ?? ''),
			name: String(item.name ?? item.id ?? ''),
			type: String(item.type ?? 'collection'),
		};
	});
}

/** Anzeige in der Auswahlliste: `Preset · Beratungsauswerter (→ medium)` bzw. `Base · low`. */
export function modelLabel(model: OwuiModel): string {
	if (model.type === 'base') return `Base · ${model.name}`;
	const target = model.baseModelId ?? '?';
	if (model.broken) return `⚠ defekt · Preset · ${model.name} (→ ${target} fehlt)`;
	return `Preset · ${model.name} (→ ${target})`;
}

/**
 * Prüft vor einem Chat, dass das Modell existiert — und bei einem Preset auch
 * sein Base-Modell. OWUI selbst meldet beides nur als `400 Model not found`.
 */
export function resolveModel(models: OwuiModel[], id: string): OwuiModel {
	const available = models.map((model) => model.id);
	const model = findModel(models, id);
	if (model.type === 'preset' && model.broken) {
		throw new OwuiCheckError(
			`Preset „${id}“ verweist auf das Base-Modell „${model.baseModelId ?? '(leer)'}“, das nicht ` +
				`existiert oder für den API-Key nicht sichtbar ist, verfügbar: ${available.join(', ')}`,
		);
	}
	return model;
}

/** Sucht ein Modell; ein unbekanntes ist ein Fehler mit der Liste der verfügbaren. */
export function findModel(models: OwuiModel[], id: string): OwuiModel {
	const available = models.map((model) => model.id);
	if (id.trim() === '') throw new OwuiCheckError('Es ist kein Modell gewählt.');
	if (available.length === 0) {
		throw new OwuiCheckError(
			`Modell „${id}“ existiert nicht: Der API-Key sieht überhaupt kein Modell. Ein Nutzer mit ` +
				'Rolle „user“ sieht Base-Modelle nur, wenn sie in Open WebUI angelegt und für ihn freigegeben sind.',
		);
	}
	const model = models.find((candidate) => candidate.id === id);
	if (!model) {
		throw new OwuiCheckError(
			`Modell „${id}“ existiert nicht oder ist für den API-Key nicht sichtbar, verfügbar: ${available.join(', ')}`,
		);
	}
	return model;
}

// ================================================================ Wissensdatenbanken

/** Seitengröße von `GET /api/v1/knowledge/` (`PAGE_ITEM_COUNT` im Fork). */
export const KNOWLEDGE_PAGE_SIZE = 30;

/** Schutz gegen eine Endlosschleife, falls OWUI `total` falsch meldet. */
const MAX_PAGES = 1000;

export interface KnowledgeBase {
	id: string;
	name: string;
	description: string;
	fileCount: number | null;
	writeAccess: boolean | null;
	createdAt: number | null;
	updatedAt: number | null;
}

interface RawKnowledge {
	id?: unknown;
	name?: unknown;
	description?: unknown;
	file_count?: unknown;
	write_access?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
}

function mapKnowledge(raw: RawKnowledge): KnowledgeBase {
	return {
		id: String(raw.id),
		name: String(raw.name ?? ''),
		description: String(raw.description ?? ''),
		fileCount: typeof raw.file_count === 'number' ? raw.file_count : null,
		writeAccess: typeof raw.write_access === 'boolean' ? raw.write_access : null,
		createdAt: typeof raw.created_at === 'number' ? raw.created_at : null,
		updatedAt: typeof raw.updated_at === 'number' ? raw.updated_at : null,
	};
}

/**
 * Liest alle Seiten eines `{items, total}`-Endpunkts.
 *
 * Ende ist erreicht, wenn eine Seite weniger als 30 Einträge bringt oder die
 * Summe `total` erreicht. Fehlt `items`, ist das ein Fehler — kein leeres Ergebnis.
 */
async function readAllPages<T>(
	client: OwuiClient,
	path: string,
	qs: Record<string, string | undefined> = {},
): Promise<T[]> {
	const all: T[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = await client.get<{ items?: unknown; total?: unknown }>(path, { ...qs, page });
		if (!body || !Array.isArray(body.items)) {
			throw new OwuiCheckError(
				`GET ${path}?page=${page} lieferte kein Feld items: ${truncate(JSON.stringify(body ?? null), 500)}`,
			);
		}
		all.push(...(body.items as T[]));
		const total = typeof body.total === 'number' ? body.total : undefined;
		if (body.items.length < KNOWLEDGE_PAGE_SIZE) return all;
		if (total !== undefined && all.length >= total) return all;
	}
	throw new OwuiCheckError(`GET ${path}: mehr als ${MAX_PAGES} Seiten — Abbruch statt Endlosschleife.`);
}

export async function listKnowledgeBases(client: OwuiClient): Promise<KnowledgeBase[]> {
	const items = await readAllPages<RawKnowledge>(client, '/api/v1/knowledge/');
	return items.map(mapKnowledge);
}

export interface KnowledgeFile {
	id: string;
	filename: string;
	hash: string | null;
	meta: Record<string, unknown>;
	createdAt: number | null;
	updatedAt: number | null;
}

/**
 * `GET /knowledge/{id}` liefert im Fork `files: null`. Die Dateien kommen
 * deshalb aus `GET /knowledge/{id}/files?page=`.
 */
export async function getKnowledgeBase(
	client: OwuiClient,
	id: string,
): Promise<KnowledgeBase & { files: KnowledgeFile[] }> {
	const knowledge = await client.get<RawKnowledge>(`/api/v1/knowledge/${segment(id)}`);
	const files = await readAllPages<{
		id?: unknown;
		filename?: unknown;
		hash?: unknown;
		meta?: unknown;
		created_at?: unknown;
		updated_at?: unknown;
	}>(client, `/api/v1/knowledge/${segment(id)}/files`);
	return {
		...mapKnowledge(knowledge),
		files: files.map((file) => ({
			id: String(file.id),
			filename: String(file.filename ?? ''),
			hash: typeof file.hash === 'string' ? file.hash : null,
			meta: (file.meta && typeof file.meta === 'object' ? file.meta : {}) as Record<string, unknown>,
			createdAt: typeof file.created_at === 'number' ? file.created_at : null,
			updatedAt: typeof file.updated_at === 'number' ? file.updated_at : null,
		})),
	};
}

/**
 * Jede gewählte Wissensdatenbank muss für den Key sichtbar sein. Im Chat
 * überspringt OWUI eine KB ohne Zugriff **ohne Fehlermeldung** — es kommen nur
 * keine Quellen. Deshalb die Prüfung vorher.
 */
export async function assertKnowledgeBasesVisible(client: OwuiClient, ids: string[]): Promise<void> {
	for (const id of ids) {
		const request = { method: 'GET' as const, path: `/api/v1/knowledge/${segment(id)}` };
		const response = await client.send(request);
		if (isSuccess(response.status)) continue;
		const error = toOwuiError(response, request);
		throw new OwuiError(
			error.status,
			error.detail,
			error.method,
			error.path,
			`Wissensdatenbank „${id}“ ist für den API-Key nicht sichtbar oder existiert nicht. ` +
				'Open WebUI würde sie im Chat ohne Fehlermeldung überspringen.',
		);
	}
}

export async function createKnowledgeBase(
	client: OwuiClient,
	name: string,
	description: string,
): Promise<KnowledgeBase> {
	if (name.trim() === '') throw new OwuiCheckError('Der Name der Wissensdatenbank ist leer.');
	const body = await client.post<RawKnowledge | null>('/api/v1/knowledge/create', {
		name,
		description,
	});
	if (!body || typeof body.id !== 'string') {
		throw new OwuiCheckError(
			`POST /api/v1/knowledge/create lieferte keine ID: ${truncate(JSON.stringify(body ?? null), 500)}`,
		);
	}
	return mapKnowledge(body);
}

export interface SearchHit {
	content: string;
	score: number | null;
	fileId: string | null;
	name: string | null;
	metadata: Record<string, unknown>;
}

/**
 * `POST /api/v1/retrieval/query/collection` — Index 0 der verschachtelten
 * Listen, nach Score absteigend. `k = 0` ignoriert OWUI (`x if x else config`),
 * deshalb wird nur ein positiver Wert gesendet.
 */
export async function searchKnowledge(
	client: OwuiClient,
	knowledgeBaseId: string,
	query: string,
	k: number,
): Promise<SearchHit[]> {
	if (query.trim() === '') throw new OwuiCheckError('Die Suchanfrage ist leer.');
	const body = await client.post<{ documents?: unknown; distances?: unknown; metadatas?: unknown }>(
		'/api/v1/retrieval/query/collection',
		{ collection_names: [knowledgeBaseId], query, ...(k > 0 ? { k } : {}) },
	);
	if (!body || !Array.isArray(body.documents)) {
		throw new OwuiCheckError(
			`Antwort der Suche ohne documents: ${truncate(JSON.stringify(body ?? null), 500)}`,
		);
	}
	const documents = (body.documents[0] ?? []) as unknown[];
	const distances = (Array.isArray(body.distances) ? body.distances[0] ?? [] : []) as unknown[];
	const metadatas = (Array.isArray(body.metadatas) ? body.metadatas[0] ?? [] : []) as unknown[];
	return documents.map((document, index) => {
		const metadata = (metadatas[index] ?? {}) as Record<string, unknown>;
		const score = distances[index];
		return {
			content: String(document ?? ''),
			score: typeof score === 'number' ? score : null,
			fileId: typeof metadata.file_id === 'string' ? metadata.file_id : null,
			name:
				typeof metadata.name === 'string'
					? metadata.name
					: typeof metadata.source === 'string'
						? metadata.source
						: null,
			metadata,
		};
	});
}

// ================================================================ Dateien

export type ProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface WaitOptions {
	timeoutMs: number;
	intervalMs: number;
}

export interface OwuiFile {
	id: string;
	filename: string;
	status: string | null;
	error: string | null;
	contentType: string | null;
	size: number | null;
	hash: string | null;
	meta: Record<string, unknown>;
	createdAt: number | null;
	updatedAt: number | null;
}

interface RawFile {
	id?: unknown;
	filename?: unknown;
	hash?: unknown;
	data?: { status?: unknown; error?: unknown; content?: unknown } | null;
	meta?: { name?: unknown; content_type?: unknown; size?: unknown } & Record<string, unknown>;
	created_at?: unknown;
	updated_at?: unknown;
}

/** `data.content` (extrahierter Volltext) bleibt bewusst draußen — er kann Megabytes groß sein. */
function mapFile(raw: RawFile): OwuiFile {
	const meta = (raw.meta ?? {}) as NonNullable<RawFile['meta']>;
	const metaWithoutData = Object.fromEntries(
		Object.entries(meta).filter(([key]) => key !== 'data'),
	) as Record<string, unknown>;
	return {
		id: String(raw.id),
		filename: String(raw.filename ?? meta.name ?? ''),
		status: typeof raw.data?.status === 'string' ? raw.data.status : null,
		error: typeof raw.data?.error === 'string' ? raw.data.error : null,
		contentType: typeof meta.content_type === 'string' ? meta.content_type : null,
		size: typeof meta.size === 'number' ? meta.size : null,
		hash: typeof raw.hash === 'string' ? raw.hash : null,
		meta: metaWithoutData,
		createdAt: typeof raw.created_at === 'number' ? raw.created_at : null,
		updatedAt: typeof raw.updated_at === 'number' ? raw.updated_at : null,
	};
}

export async function getFile(client: OwuiClient, id: string): Promise<OwuiFile> {
	return mapFile(await client.get<RawFile>(`/api/v1/files/${segment(id)}`));
}

/**
 * `GET /api/v1/files/search` — `filename` ist ein Glob (`*`, `?`), kein
 * Teilstring, und durchsucht nur **eigene** Dateien des Key-Nutzers.
 * Ein leeres Ergebnis meldet OWUI als **404** „No files found…“; das ist hier
 * eine leere Liste, jeder andere Fehler bleibt ein Fehler.
 */
export async function searchFiles(
	client: OwuiClient,
	pattern: string,
	limit: number,
): Promise<OwuiFile[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
		throw new OwuiCheckError(`Die maximale Anzahl muss zwischen 1 und 1000 liegen, war ${limit}.`);
	}
	const request = {
		method: 'GET' as const,
		path: '/api/v1/files/search',
		qs: { filename: pattern.trim() === '' ? '*' : pattern, content: false, limit },
	};
	const response = await client.send(request);
	if (response.status === 404 && /no files found/i.test(extractDetail(response.body))) return [];
	if (!isSuccess(response.status)) throw toOwuiError(response, request);
	if (!Array.isArray(response.body)) {
		throw new OwuiCheckError(
			`Dateisuche lieferte keine Liste: ${truncate(JSON.stringify(response.body ?? null), 500)}`,
		);
	}
	return (response.body as RawFile[]).map(mapFile);
}

/** Baut aus einer freien Eingabe ein Glob für eine Teilsuche. */
export function substringPattern(filter: string | undefined): string {
	const trimmed = (filter ?? '').trim();
	if (trimmed === '') return '*';
	return /[*?]/.test(trimmed) ? trimmed : `*${trimmed}*`;
}

export interface DownloadedFile {
	file: OwuiFile;
	data: Buffer;
	mimeType: string;
}

export async function downloadFile(client: OwuiClient, id: string): Promise<DownloadedFile> {
	const file = await getFile(client, id);
	const response = await client.request<unknown>({
		method: 'GET',
		path: `/api/v1/files/${segment(id)}/content`,
		binary: true,
	});
	const data = toBuffer(response.body);
	const mimeType = file.contentType ?? response.headers['content-type'];
	if (!mimeType) {
		throw new OwuiCheckError(`Datei ${id}: weder Metadaten noch Antwort nennen einen MIME-Type.`);
	}
	return { file, data, mimeType };
}

function toBuffer(body: unknown): Buffer {
	if (Buffer.isBuffer(body)) return body;
	if (body instanceof ArrayBuffer) return Buffer.from(body);
	if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
	if (typeof body === 'string') return Buffer.from(body, 'binary');
	throw new OwuiCheckError(`Download lieferte keine Binärdaten, sondern ${typeof body}.`);
}

/** `GET /files/{id}/process/status` → der gemeldete Status als Text. */
async function getProcessStatus(
	client: OwuiClient,
	fileId: string,
	timeoutMs?: number,
): Promise<string> {
	const response = await client.request<{ status?: unknown } | null>({
		method: 'GET',
		path: `/api/v1/files/${segment(fileId)}/process/status`,
		timeoutMs,
	});
	return String(response.body?.status ?? '');
}

/**
 * Löst ein `pending` des Status-Endpunkts auf. OWUI meldet `pending` auch, wenn
 * `data.status` ganz fehlt (`files.py:694`: `data.get('status', 'pending')`) —
 * bei Uploads mit `process=false` und Altdateien. Solche Dateien bekommen nie
 * einen Status; Warten liefe nur in den Timeout.
 *
 * Maßgeblich ist dann, was `file/add` selbst braucht: Liegt extrahierter Inhalt
 * in `data.content`, ist die Datei verarbeitet. Ohne Status und ohne Inhalt → Fehler.
 */
async function resolvePending(client: OwuiClient, fileId: string): Promise<string> {
	const raw = await client.get<RawFile | null>(`/api/v1/files/${segment(fileId)}`);
	if (typeof raw?.data?.status === 'string') return raw.data.status;
	if (typeof raw?.data?.content === 'string' && raw.data.content.trim() !== '') return 'completed';
	throw new OwuiCheckError(
		`Datei ${fileId} hat keinen Verarbeitungsstatus und keinen extrahierten Inhalt (Upload mit ` +
			'process=false oder Altdatei). Open WebUI verarbeitet sie nie von selbst — die Datei neu hochladen.',
	);
}

/** Verarbeitungsstatus einer beliebigen Datei; `pending` ohne echten Status wird aufgelöst. */
export async function fileProcessingStatus(client: OwuiClient, fileId: string): Promise<string> {
	const status = await getProcessStatus(client, fileId);
	return status === 'pending' ? resolvePending(client, fileId) : status;
}

/**
 * Fragt `GET /files/{id}/process/status` ab, bis `completed`.
 *
 * Bei `failed` steht der Grund nur in `GET /files/{id}` → `data.error`; der
 * Status-Endpunkt nennt ihn ohne `stream` nicht. Gewartet wird über das
 * injizierte `sleep` (in n8n: `sleep` aus `n8n-workflow`, `setTimeout` ist für
 * Community-Nodes gesperrt).
 *
 * Der Timeout gilt für die Wanduhr (`client.now`), nicht nur für die
 * Schlafzeit: Auch die Statusabfragen zählen, und jede Abfrage darf höchstens
 * die Restzeit dauern (mindestens 1 s).
 *
 * `statusKnown = false`, wenn nicht feststeht, dass die Datei überhaupt einen
 * Status trägt — dann wird das erste `pending` über `GET /files/{id}` geprüft.
 */
export async function waitForProcessing(
	client: OwuiClient,
	fileId: string,
	options: WaitOptions,
	statusKnown = true,
): Promise<void> {
	const deadline = client.now() + options.timeoutMs;
	let verified = statusKnown;
	for (;;) {
		const remaining = deadline - client.now();
		let status = await getProcessStatus(
			client,
			fileId,
			Math.max(1_000, Math.min(remaining, DEFAULT_REQUEST_TIMEOUT_MS)),
		);
		if (status === 'pending' && !verified) {
			status = await resolvePending(client, fileId);
			verified = true;
		}
		if (status === 'completed') return;
		if (status === 'failed') {
			const file = await getFile(client, fileId);
			throw new OwuiCheckError(
				`Open WebUI konnte die Datei ${fileId} nicht verarbeiten: ${file.error ?? '(kein Grund genannt)'}`,
			);
		}
		if (status !== 'pending' && status !== 'processing') {
			throw new OwuiCheckError(`Unbekannter Verarbeitungsstatus „${status}“ für Datei ${fileId}.`);
		}
		const left = deadline - client.now();
		if (left <= 0) {
			throw new OwuiCheckError(
				`Datei ${fileId} ist nach ${Math.round(options.timeoutMs / 1000)} s noch nicht verarbeitet ` +
					`(Status ${status}). Timeout erhöhen oder später „Add File“ ausführen.`,
			);
		}
		await client.sleep(Math.min(options.intervalMs, left));
	}
}

export interface UploadInput {
	data: Buffer;
	filename: string;
	mimeType: string;
}

/**
 * Prüft die Binärdaten für Upload und Transkription. Ohne Dateinamen oder
 * MIME-Type wird nicht geraten: OWUI prüft den MIME-Type des Parts (Audio:
 * `audio/*`), ein erfundener Wert verschiebt den Fehler nur.
 */
export function toUploadInput(
	property: string,
	data: Buffer,
	binary: { fileNameOverride?: string; fileName?: string; mimeType?: string },
): UploadInput {
	const filename = (binary.fileNameOverride ?? '').trim() || (binary.fileName ?? '').trim();
	if (filename === '') {
		throw new OwuiCheckError(
			`Das Binärfeld „${property}“ hat keinen Dateinamen. Bitte „Dateiname“ setzen.`,
		);
	}
	if (!binary.mimeType) {
		throw new OwuiCheckError(`Das Binärfeld „${property}“ hat keinen MIME-Type.`);
	}
	return { data, filename, mimeType: binary.mimeType };
}

/** n8n liefert `json`-Felder je nach Herkunft als String oder als Objekt. Leer → `undefined`. */
export function parseJsonObject(raw: unknown, label: string): Record<string, unknown> | undefined {
	let value = raw;
	if (typeof raw === 'string') {
		if (raw.trim() === '') return undefined;
		const parsed = parseJson(raw);
		if (!parsed.ok) throw new OwuiCheckError(`${label}: kein gültiges JSON — ${parsed.error}`);
		value = parsed.value;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new OwuiCheckError(`${label}: erwartet wird ein JSON-Objekt.`);
	}
	return Object.keys(value).length === 0 ? undefined : (value as Record<string, unknown>);
}

export interface UploadOptions {
	/** `null` heißt: nicht warten. */
	wait: WaitOptions | null;
	knowledgeBaseId?: string;
}

export interface UploadResult {
	id: string;
	filename: string;
	/** Wie von Open WebUI gemeldet; `null`, wenn die Upload-Antwort keinen Status trägt. */
	status: string | null;
	knowledgeBaseId: string | null;
}

/** Feldname des Datei-Parts. Als Konstante, damit der Lint `{ name, value }` nicht für eine Option hält. */
const MULTIPART_FILE_FIELD = 'file';

/**
 * Upload nach `POST /api/v1/files/` (Verarbeitung im Hintergrund, Antwort
 * `pending`). Mit Wissensdatenbank wird **danach** explizit `file/add`
 * aufgerufen — nicht über `metadata.knowledge_id`, denn dort meldet OWUI ein
 * fehlendes Schreibrecht nur im Log, nicht als Fehler.
 */
export async function uploadFile(
	client: OwuiClient,
	input: UploadInput,
	options: UploadOptions,
): Promise<UploadResult> {
	if (options.knowledgeBaseId && options.wait === null) {
		throw new OwuiCheckError(
			'Mit Wissensdatenbank muss auf die Verarbeitung gewartet werden: „Add File“ vor Abschluss würde die ' +
				'Datei in Open WebUI auf „failed“ setzen. „Auf Verarbeitung Warten“ einschalten.',
		);
	}
	const { body, contentType } = buildMultipart([
		{
			name: MULTIPART_FILE_FIELD,
			value: { data: input.data, filename: input.filename, contentType: input.mimeType },
		},
	]);
	const response = await client.request<RawFile>({
		method: 'POST',
		path: '/api/v1/files/',
		rawBody: body,
		headers: { 'Content-Type': contentType },
	});
	if (!response.body || typeof response.body.id !== 'string') {
		throw new OwuiCheckError(
			`Upload lieferte keine Datei-ID: ${truncate(JSON.stringify(response.body ?? null), 500)}`,
		);
	}
	const id = response.body.id;
	let status: string | null =
		typeof response.body.data?.status === 'string' ? response.body.data.status : null;

	if (options.wait !== null) {
		await waitForProcessing(client, id, options.wait, status !== null);
		status = 'completed';
	}
	if (options.knowledgeBaseId) {
		await postFileAdd(client, options.knowledgeBaseId, id);
	}
	return {
		id,
		filename: String(response.body.filename ?? input.filename),
		status,
		knowledgeBaseId: options.knowledgeBaseId ?? null,
	};
}

export interface KnowledgeFileChange {
	knowledgeBaseId: string;
	fileId: string;
	knowledgeBaseName: string | null;
}

/**
 * Fügt eine Datei einer Wissensdatenbank hinzu.
 *
 * Vorher muss die Datei `completed` sein: Läuft die Verarbeitung noch, endet
 * `file/add` in „The content provided is empty“ **und setzt die Datei auf
 * `failed`**. Deshalb wird der Status zuerst geprüft und — falls gewünscht —
 * abgewartet. Eine Datei ganz ohne Status (siehe `resolvePending`) gilt mit
 * extrahiertem Inhalt als fertig, ohne Inhalt ist sie ein Fehler.
 */
export async function addFileToKnowledge(
	client: OwuiClient,
	knowledgeBaseId: string,
	fileId: string,
	wait: WaitOptions | null,
): Promise<KnowledgeFileChange> {
	const status = await fileProcessingStatus(client, fileId);
	if (status !== 'completed') {
		if (status === 'failed' || wait === null) {
			throw new OwuiCheckError(
				`Datei ${fileId} hat den Status „${status}“ statt „completed“. „Add File“ vor Abschluss der ` +
					'Verarbeitung würde sie in Open WebUI auf „failed“ setzen.',
			);
		}
		await waitForProcessing(client, fileId, wait);
	}
	return postFileAdd(client, knowledgeBaseId, fileId);
}

async function postFileAdd(
	client: OwuiClient,
	knowledgeBaseId: string,
	fileId: string,
): Promise<KnowledgeFileChange> {
	const body = await client.post<{ name?: unknown } | null>(
		`/api/v1/knowledge/${segment(knowledgeBaseId)}/file/add`,
		{ file_id: fileId },
	);
	return {
		knowledgeBaseId,
		fileId,
		knowledgeBaseName: typeof body?.name === 'string' ? body.name : null,
	};
}

/**
 * Entfernt eine Datei aus einer Wissensdatenbank. `delete_file=false` wird
 * immer gesendet: Der OWUI-Default löscht die Datei sonst ganz, sobald der Key
 * ihr Eigentümer ist — und Löschen bietet dieser Baustein bewusst nicht an.
 */
export async function removeFileFromKnowledge(
	client: OwuiClient,
	knowledgeBaseId: string,
	fileId: string,
): Promise<KnowledgeFileChange> {
	const body = await client.post<{ name?: unknown } | null>(
		`/api/v1/knowledge/${segment(knowledgeBaseId)}/file/remove`,
		{ file_id: fileId },
		{ delete_file: false },
	);
	return {
		knowledgeBaseId,
		fileId,
		knowledgeBaseName: typeof body?.name === 'string' ? body.name : null,
	};
}

// ================================================================ Audio

export async function transcribe(
	client: OwuiClient,
	input: UploadInput,
	language: string,
): Promise<{ text: string; filename: string | null }> {
	const parts: MultipartPart[] = [
		{
			name: MULTIPART_FILE_FIELD,
			value: { data: input.data, filename: input.filename, contentType: input.mimeType },
		},
	];
	if (language.trim() !== '') parts.push({ name: 'language', value: language.trim() });
	const { body, contentType } = buildMultipart(parts);
	const response = await client.request<{ text?: unknown; filename?: unknown }>({
		method: 'POST',
		path: '/api/v1/audio/transcriptions',
		rawBody: body,
		headers: { 'Content-Type': contentType },
	});
	if (!response.body || typeof response.body.text !== 'string') {
		throw new OwuiCheckError(
			`Transkription ohne Feld text: ${truncate(JSON.stringify(response.body ?? null), 500)}`,
		);
	}
	return {
		text: response.body.text,
		filename: typeof response.body.filename === 'string' ? response.body.filename : null,
	};
}

// ================================================================ Chat

export interface ChatMessage {
	role: string;
	content: unknown;
}

export interface ChatInput {
	model: string;
	systemPrompt: string;
	/** Entweder `prompt` oder `messages`. */
	prompt?: string;
	messages?: ChatMessage[];
	knowledgeBaseIds: string[];
	fileIds: string[];
	temperature?: number;
	responseFormat?: Record<string, unknown>;
}

export type RequireSources = 'auto' | 'always' | 'never';

export interface ChatChecks {
	requireSources: RequireSources;
	parseJson: boolean;
	checkModel: boolean;
	includeRaw: boolean;
	timeoutMs: number;
}

export interface ChatSource {
	name: string | null;
	id: string | null;
	knowledgeBaseId: string | null;
}

export interface ChatResult {
	content: string;
	json?: unknown;
	model: string | null;
	usage: unknown;
	sources: ChatSource[];
	raw?: unknown;
}

/** Prüft ein Messages-JSON, statt es ungeprüft durchzureichen. */
export function parseMessages(raw: unknown): ChatMessage[] {
	let value = raw;
	if (typeof raw === 'string') {
		const parsed = parseJson(raw);
		if (!parsed.ok) throw new OwuiCheckError(`Messages: kein gültiges JSON — ${parsed.error}`);
		value = parsed.value;
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new OwuiCheckError('Messages muss ein nicht leeres Array aus {role, content} sein.');
	}
	return value.map((entry, index) => {
		const message = entry as { role?: unknown; content?: unknown };
		if (typeof message?.role !== 'string' || message.content === undefined) {
			throw new OwuiCheckError(`Messages[${index}] braucht role (Text) und content.`);
		}
		return { role: message.role, content: message.content };
	});
}

/** Datei-IDs aus einer Liste mit Komma, Semikolon oder Zeilenumbruch. */
export function splitIds(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map(String).map((id) => id.trim()).filter(Boolean);
	return String(raw ?? '')
		.split(/[\s,;]+/)
		.map((id) => id.trim())
		.filter(Boolean);
}

/**
 * Baut den Body für `POST /api/chat/completions`.
 *
 * Bewusst **ohne** `chat_id`, `session_id` und `id`: mit diesen Feldern
 * antwortet OWUI asynchron mit `task_ids` statt mit einer Completion.
 */
export function buildChatBody(input: ChatInput): Record<string, unknown> {
	const messages: ChatMessage[] = [];
	if (input.systemPrompt.trim() !== '') messages.push({ role: 'system', content: input.systemPrompt });
	if (input.messages) messages.push(...input.messages);
	else if (input.prompt !== undefined) {
		if (input.prompt.trim() === '') throw new OwuiCheckError('Der Prompt ist leer.');
		messages.push({ role: 'user', content: input.prompt });
	} else {
		throw new OwuiCheckError('Weder Prompt noch Messages gesetzt.');
	}

	const files = [
		...input.knowledgeBaseIds.map((id) => ({ type: 'collection', id })),
		...input.fileIds.map((id) => ({ type: 'file', id })),
	];

	return {
		model: input.model,
		messages,
		stream: false,
		...(files.length > 0 ? { files } : {}),
		...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
		...(input.responseFormat ? { response_format: input.responseFormat } : {}),
	};
}

/**
 * OWUI liefert `sources` ohne Stream als Top-Level-Feld. Je Source steht die
 * eigentliche Datei in `metadata[]`; ohne Metadaten bleibt nur das Request-Item.
 */
export function mapSources(raw: unknown): ChatSource[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: ChatSource[] = [];
	const push = (source: ChatSource) => {
		const key = `${source.id ?? ''}|${source.name ?? ''}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push(source);
	};
	for (const entry of raw) {
		const item = entry as { source?: Record<string, unknown>; metadata?: unknown };
		const origin = item.source ?? {};
		const knowledgeBaseId =
			origin.type === 'collection' && typeof origin.id === 'string' ? origin.id : null;
		const metadata = Array.isArray(item.metadata) ? (item.metadata as Record<string, unknown>[]) : [];
		if (metadata.length === 0) {
			push({
				name: typeof origin.name === 'string' ? origin.name : null,
				id: typeof origin.id === 'string' ? origin.id : null,
				knowledgeBaseId,
			});
			continue;
		}
		for (const meta of metadata) {
			push({
				name:
					typeof meta?.name === 'string'
						? meta.name
						: typeof meta?.source === 'string'
							? meta.source
							: null,
				id: typeof meta?.file_id === 'string' ? meta.file_id : null,
				knowledgeBaseId,
			});
		}
	}
	return out;
}

/**
 * Prüft die Chat-Antwort, statt still Unbrauchbares weiterzugeben:
 * SSE statt JSON, fehlender Inhalt, abweichendes Modell, fehlende Quellen,
 * ungültiges JSON.
 */
export function parseChatResponse(
	response: { status: number; body: unknown; headers: Record<string, string> },
	context: { requested: OwuiModel; knowledgeBaseIds: string[]; fileIds: string[] },
	checks: ChatChecks,
): ChatResult {
	const contentType = response.headers['content-type'] ?? '';
	if (/text\/event-stream/i.test(contentType) || typeof response.body === 'string') {
		throw new OwuiCheckError(
			'Open WebUI hat gestreamt (SSE) statt JSON zu liefern. Ursache ist fast immer „Stream Chat ' +
				`Response“ (stream_response) im Preset „${context.requested.id}“ oder in den globalen ` +
				'Modell-Standardparametern — das überschreibt stream:false aus dem Request. In Open WebUI ' +
				'unter Modell → Erweiterte Parameter auf „Standard“ oder „Aus“ stellen.',
		);
	}
	const body = response.body as {
		model?: unknown;
		choices?: Array<{ message?: { content?: unknown } }>;
		usage?: unknown;
		sources?: unknown;
	} | null;
	const content = body?.choices?.[0]?.message?.content;
	if (typeof content !== 'string') {
		throw new OwuiCheckError(
			`Antwort ohne choices[0].message.content: ${truncate(JSON.stringify(body ?? null), 500)}`,
		);
	}

	const model = typeof body?.model === 'string' ? body.model : null;
	if (checks.checkModel && !modelMatches(model, context.requested)) {
		const accepted = [context.requested.id, context.requested.baseModelId].filter(
			(id): id is string => typeof id === 'string',
		);
		throw new OwuiCheckError(
			`Die Antwort kam von Modell „${model ?? '(nicht angegeben)'}“, angefragt war ` +
				`„${accepted.join('“ bzw. „')}“. Open WebUI reicht den Namen des Anbieters durch; meldet ` +
				'der Anbieter einen Deployment- oder Snapshot-Namen, die Option „Modell Abgleichen“ abschalten.',
		);
	}

	const sources = mapSources(body?.sources);
	const wantsSources =
		checks.requireSources === 'always' ||
		(checks.requireSources === 'auto' &&
			(context.knowledgeBaseIds.length > 0 || context.fileIds.length > 0));
	if (wantsSources && sources.length === 0) {
		throw new OwuiCheckError(
			'Die Antwort enthält keine Quellen, obwohl „Quellen Erforderlich“ greift. Mögliche Ursachen: ' +
				'Dateien noch nicht verarbeitet, Wissensdatenbank leer, kein Lesezugriff auf einzelne Dateien ' +
				'(Open WebUI überspringt sie ohne Fehler) oder das Modell hat „File Context“ abgeschaltet. ' +
				`Wissensdatenbanken: ${context.knowledgeBaseIds.join(', ') || '—'}; Dateien: ${context.fileIds.join(', ') || '—'}.`,
		);
	}

	const result: ChatResult = { content, model, usage: body?.usage ?? null, sources };
	if (checks.parseJson) {
		const parsed = parseJson(content);
		if (!parsed.ok) {
			throw new OwuiCheckError(
				`Die Antwort ist kein gültiges JSON (${parsed.error}). Erste 500 Zeichen: ${truncate(content, 500)}`,
			);
		}
		result.json = parsed.value;
	}
	if (checks.includeRaw) result.raw = body;
	return result;
}

/**
 * Stimmt das `model` der Antwort mit dem angefragten Modell überein?
 *
 * Angenommen werden die OWUI-ID und bei Presets das Base-Modell, jeweils auch
 * ohne den `prefix_id` der Verbindung: OWUI führt das Modell als
 * `<prefix>.<id>`, schickt dem Anbieter aber `<id>` (`routers/openai.py`,
 * `strip_provider_model_prefix`), und dessen Antwort kommt unverändert zurück.
 * Erkannt wird das am Suffix `.<model>` — ein Präfix wird nicht geraten.
 */
export function modelMatches(model: string | null, requested: OwuiModel): boolean {
	if (model === null || model === '') return false;
	return [requested.id, requested.baseModelId]
		.filter((id): id is string => typeof id === 'string')
		.some((id) => id === model || id.endsWith(`.${model}`));
}

/**
 * Jede Datei-ID muss für den Key sichtbar und fertig verarbeitet sein. Sonst
 * überspringt OWUI sie im Chat **ohne Fehlermeldung** — wie bei
 * Wissensdatenbanken (`assertKnowledgeBasesVisible`).
 */
export async function assertFilesReady(client: OwuiClient, ids: string[]): Promise<void> {
	for (const id of ids) {
		const request = {
			method: 'GET' as const,
			path: `/api/v1/files/${segment(id)}/process/status`,
		};
		const response = await client.send(request);
		if (!isSuccess(response.status)) {
			const error = toOwuiError(response, request);
			throw new OwuiError(
				error.status,
				error.detail,
				error.method,
				error.path,
				`Datei „${id}“ ist für den API-Key nicht sichtbar oder existiert nicht. ` +
					'Open WebUI würde sie im Chat ohne Fehlermeldung überspringen.',
			);
		}
		const reported = String((response.body as { status?: unknown } | null)?.status ?? '');
		const status = reported === 'pending' ? await resolvePending(client, id) : reported;
		if (status !== 'completed') {
			throw new OwuiCheckError(
				`Datei ${id} hat den Status „${status}“ statt „completed“. Open WebUI würde sie im Chat ` +
					'ohne Inhalt übergehen. Erst nach Abschluss der Verarbeitung fragen.',
			);
		}
	}
}

/** Ablauf eines Chats: Modell prüfen, Wissensdatenbanken und Dateien prüfen, senden, Antwort prüfen. */
export async function chatComplete(
	client: OwuiClient,
	models: OwuiModel[],
	input: ChatInput,
	checks: ChatChecks,
): Promise<ChatResult> {
	const requested = resolveModel(models, input.model);
	await assertKnowledgeBasesVisible(client, input.knowledgeBaseIds);
	await assertFilesReady(client, input.fileIds);
	const response = await client.request({
		method: 'POST',
		path: '/api/chat/completions',
		body: buildChatBody(input),
		timeoutMs: checks.timeoutMs,
	});
	return parseChatResponse(
		response,
		{ requested, knowledgeBaseIds: input.knowledgeBaseIds, fileIds: input.fileIds },
		checks,
	);
}

// ================================================================ Optionen

/**
 * Optionswerte kommen per Ausdruck auch als Text oder ganz falsch an. Nur ein
 * fehlendes Feld (`undefined`) bekommt den Default — alles andere wird geprüft,
 * statt still ersetzt zu werden.
 */
export function toRequireSources(value: unknown): RequireSources {
	if (value === undefined) return 'auto';
	if (value === 'auto' || value === 'always' || value === 'never') return value;
	throw new OwuiCheckError(
		`„Quellen Erforderlich“ muss auto, always oder never sein, war ${JSON.stringify(value)}.`,
	);
}

/** Sekunden > 0; Zahl oder Zahl als Text. */
export function toSeconds(value: unknown, label: string, fallback: number): number {
	if (value === undefined) return fallback;
	const seconds = toNumber(value);
	if (seconds === undefined || seconds <= 0) {
		throw new OwuiCheckError(
			`„${label}“ muss eine Zahl größer 0 sein (Sekunden), war ${JSON.stringify(value)}.`,
		);
	}
	return seconds;
}

/** Optionale Zahl: fehlt sie, `undefined`; ist sie keine Zahl, ein Fehler. */
export function toOptionalNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	const number = toNumber(value);
	if (number === undefined) {
		throw new OwuiCheckError(`„${label}“ muss eine Zahl sein, war ${JSON.stringify(value)}.`);
	}
	return number;
}

function toNumber(value: unknown): number | undefined {
	const number =
		typeof value === 'number'
			? value
			: typeof value === 'string' && value.trim() !== ''
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) ? number : undefined;
}
