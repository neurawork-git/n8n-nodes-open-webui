/**
 * Open-WebUI-Client — transportfrei.
 *
 * Nichts hier kennt n8n. Injiziert werden genau zwei Dinge: eine HTTP-Funktion
 * und eine Warte-Funktion. In n8n übernimmt `httpRequestWithAuthentication` die
 * Anmeldung und `sleep` aus `n8n-workflow` das Warten; in den Tests stehen dort
 * Fakes. Ein Test stellt sicher, dass dieser Ordner `n8n-workflow` nie importiert.
 *
 * Regeln, die nicht verhandelbar sind:
 *  - **Kein Silent-Fail.** Jede Nicht-2xx-Antwort wird zu einem `OwuiError` mit
 *    Status, OWUI-`detail`, Methode und Pfad (der Pfad trägt die ID). Nie ein
 *    leeres Ergebnis statt eines Fehlers.
 *  - **Kein eigener Retry.** Wiederholen ist Sache von n8ns „Retry on Fail“.
 */

import { randomBytes } from 'crypto';

export type HttpMethod = 'GET' | 'POST';

export type QueryValue = string | number | boolean;

export interface OwuiRequest {
	method: HttpMethod;
	/** Pfad unterhalb der Basis-URL, beginnt mit `/`. */
	path: string;
	qs?: Record<string, QueryValue | undefined>;
	/** JSON-Body. */
	body?: unknown;
	/** Fertig kodierter Body (multipart). Schließt `body` aus. */
	rawBody?: Buffer;
	headers?: Record<string, string>;
	/** Antwort als Buffer statt JSON (Datei-Download). */
	binary?: boolean;
	timeoutMs?: number;
}

export interface OwuiHttpRequest extends OwuiRequest {
	/** Absolute URL ohne Query; die Query liegt in `qs`. */
	url: string;
}

export interface OwuiHttpResponse {
	status: number;
	body: unknown;
	/** Antwort-Header, Schlüssel kleingeschrieben. */
	headers: Record<string, string>;
}

/** Die einzige Abhängigkeit nach außen. */
export type OwuiHttp = (request: OwuiHttpRequest) => Promise<OwuiHttpResponse>;

export type Sleep = (ms: number) => Promise<void>;

/** Wanduhr in Millisekunden — injiziert, damit Tests die Zeit mit `sleep` vorstellen können. */
export type Now = () => number;

/** Timeout je Anfrage, wenn die Anfrage keinen eigenen setzt (alles außer Chat). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export interface OwuiClientOptions {
	baseUrl: string;
	http: OwuiHttp;
	sleep: Sleep;
	/** Default: `Date.now`. */
	now?: Now;
}

/** Fehler aus einer HTTP-Antwort von Open WebUI. Die Node macht daraus `NodeApiError`. */
export class OwuiError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string,
		readonly method: HttpMethod,
		readonly path: string,
		readonly hint = '',
	) {
		super(`Open WebUI ${status} bei ${method} ${path}: ${detail}${hint ? ` — ${hint}` : ''}`);
		this.name = 'OwuiError';
	}

	toJSON(): Record<string, string | number> {
		return {
			status: this.status,
			detail: this.detail,
			endpoint: `${this.method} ${this.path}`,
			...(this.hint ? { hint: this.hint } : {}),
		};
	}
}

/**
 * Fehler aus einer Prüfung der Node selbst (Modell fehlt, SSE statt JSON,
 * Quellen leer …). Kein HTTP-Status; die Node macht daraus `NodeOperationError`.
 */
export class OwuiCheckError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'OwuiCheckError';
	}
}

export class OwuiClient {
	readonly baseUrl: string;

	readonly sleep: Sleep;

	readonly now: Now;

	private readonly http: OwuiHttp;

	constructor(options: OwuiClientOptions) {
		const baseUrl = String(options.baseUrl ?? '').trim().replace(/\/+$/, '');
		if (!/^https?:\/\/[^/]+/i.test(baseUrl)) {
			throw new OwuiCheckError(
				`Die Base URL der Credential ist ungültig („${options.baseUrl}“). Erwartet wird z. B. ` +
					'http://open-webui.<namespace>.svc.cluster.local:8080 ohne Pfad.',
			);
		}
		this.baseUrl = baseUrl;
		this.http = options.http;
		this.sleep = options.sleep;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Sendet und liefert die Antwort ungeprüft — für die wenigen Stellen, die Status selbst deuten.
	 *
	 * Kommt gar keine Antwort (Timeout, Verbindung abgelehnt, DNS), wird daraus
	 * ein `OwuiCheckError` mit Methode, Pfad und — beim Timeout — der Dauer. Die
	 * Ursache hängt als `cause` daran. Über `.then(ok, fail)` statt try/catch,
	 * weil der Lint in `catch`-Blöcken nur n8n-Fehlerklassen erlaubt.
	 */
	async send(request: OwuiRequest): Promise<OwuiHttpResponse> {
		const qs: Record<string, QueryValue> = {};
		for (const [key, value] of Object.entries(request.qs ?? {})) {
			if (value !== undefined) qs[key] = value;
		}
		const outcome = await this.http({
			...request,
			qs: Object.keys(qs).length > 0 ? qs : undefined,
			url: `${this.baseUrl}${request.path}`,
		}).then(
			(response) => ({ ok: true as const, response }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		if (!outcome.ok) throw transportError(outcome.error, request);
		return { ...outcome.response, headers: lowerCaseKeys(outcome.response.headers) };
	}

	/** Sendet und wirft bei jeder Nicht-2xx-Antwort einen `OwuiError`. */
	async request<T = unknown>(request: OwuiRequest): Promise<OwuiHttpResponse & { body: T }> {
		const response = await this.send(request);
		if (!isSuccess(response.status)) throw toOwuiError(response, request);
		return response as OwuiHttpResponse & { body: T };
	}

	async get<T = unknown>(path: string, qs?: OwuiRequest['qs']): Promise<T> {
		return (await this.request<T>({ method: 'GET', path, qs })).body;
	}

	async post<T = unknown>(path: string, body: unknown, qs?: OwuiRequest['qs']): Promise<T> {
		return (await this.request<T>({ method: 'POST', path, body, qs })).body;
	}
}

/** Fehler ohne HTTP-Antwort — mit Endpunkt und, beim Timeout, mit Dauer und Hinweis. */
export function transportError(error: unknown, request: OwuiRequest): OwuiCheckError {
	const cause = error instanceof Error ? error : new Error(String(error));
	const code = String((error as { code?: unknown } | null)?.code ?? '');
	const endpoint = `${request.method} ${request.path}`;
	const timeoutMs = request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const isTimeout =
		code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout|timed out/i.test(cause.message);
	const message = isTimeout
		? `Keine Antwort von ${endpoint} nach ${Math.round(timeoutMs / 1000)} s (${cause.message}).` +
			(request.path.startsWith('/api/chat/completions')
				? ' RAG-Antworten brauchen oft Minuten: Option „Timeout in Sekunden“ erhöhen.'
				: '')
		: `Keine Antwort von ${endpoint}: ${cause.message}${code ? ` (${code})` : ''}. ` +
			'Base URL der Credential und Erreichbarkeit von Open WebUI prüfen.';
	return new OwuiCheckError(message, { cause });
}

export function isSuccess(status: number): boolean {
	return status >= 200 && status < 300;
}

/** Hängt einen Pfadteil sicher an — IDs kommen aus Nutzereingaben. */
export function segment(value: string): string {
	return encodeURIComponent(value);
}

function lowerCaseKeys(headers: Record<string, string> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers ?? {})) {
		out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
	}
	return out;
}

/**
 * Liest das OWUI-`detail` aus einer Fehlerantwort.
 *
 * FastAPI liefert `{"detail": "<text>"}`, bei einem Body, der nicht zum Schema
 * passt (422), aber `{"detail": [{loc, msg, type}]}` — ein Array, kein String.
 * Beim Download kommt die Fehlerantwort als Buffer.
 */
export function extractDetail(body: unknown): string {
	let value: unknown = body;
	if (Buffer.isBuffer(value)) value = value.toString('utf8');
	if (value instanceof ArrayBuffer) value = Buffer.from(value).toString('utf8');
	if (typeof value === 'string') {
		const parsed = parseJson(value);
		if (!parsed.ok) return truncate(value.trim() || '(leere Antwort)', 500);
		value = parsed.value;
	}
	if (value && typeof value === 'object') {
		const detail = (value as { detail?: unknown }).detail;
		if (typeof detail === 'string') return detail;
		if (Array.isArray(detail)) {
			return detail
				.map((entry) => {
					const item = entry as { loc?: unknown[]; msg?: unknown };
					const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
					return loc ? `${loc}: ${String(item.msg)}` : String(item.msg ?? JSON.stringify(entry));
				})
				.join('; ');
		}
		const error = (value as { error?: { message?: unknown } }).error;
		if (error && typeof error.message === 'string') return error.message;
		return truncate(JSON.stringify(value), 500);
	}
	if (value === undefined || value === null || value === '') return '(leere Antwort)';
	return truncate(String(value), 500);
}

/**
 * Übersetzt eine Fehlerantwort in einen `OwuiError` mit einem Hinweis, der den
 * Unterschied benennt, der beim Debuggen zählt.
 */
export function toOwuiError(response: OwuiHttpResponse, request: OwuiRequest): OwuiError {
	const detail = extractDetail(response.body);
	return new OwuiError(
		response.status,
		detail,
		request.method,
		request.path,
		hintFor(response.status, detail, request.path),
	);
}

function hintFor(status: number, detail: string, path: string): string {
	if (status === 401 && /not authenticated|token is invalid|session has expired/i.test(detail)) {
		return 'API-Key fehlt, ist ungültig oder wurde in Open WebUI widerrufen.';
	}
	if (status === 403 && /api key is not enabled/i.test(detail)) {
		return (
			'API-Keys sind in Open WebUI abgeschaltet oder dem Nutzer hinter dem Key fehlt die ' +
			'Berechtigung „API Keys“ (features.api_keys).'
		);
	}
	if ((status === 401 || status === 403) && /permission to access/i.test(detail)) {
		return (
			'Dem Nutzer hinter dem Key fehlt die Freigabe für diese Ressource, oder ' +
			'API_KEYS_ALLOWED_ENDPOINTS lässt den Pfad nicht zu.'
		);
	}
	if (status === 400 && /model not found/i.test(detail)) {
		return 'Open WebUI kennt das Modell nicht (es steht nicht in /api/models).';
	}
	if (status === 403 && /model not found/i.test(detail)) {
		return (
			'Das Modell existiert, aber dem Nutzer hinter dem Key fehlt die Freigabe — ' +
			'bei einem Preset auch für dessen Base-Modell.'
		);
	}
	if (status === 400 && path.startsWith('/api/chat/completions')) {
		return (
			'Open WebUI reicht Fehler des Modell-Anbieters (auch Rate-Limits) als 400 durch; ' +
			'der ursprüngliche Status ist nicht mehr erkennbar.'
		);
	}
	if (status === 400 && /not supported|invalid audio file/i.test(detail)) {
		return 'Der MIME-Type der Binärdaten muss zum Inhalt passen (Audio: audio/* oder video/webm).';
	}
	if (status === 413) {
		return 'Die Datei überschreitet das Upload-Limit von Open WebUI.';
	}
	if (status === 404 && /\/api\/v1\/files\//.test(path)) {
		return 'Datei unbekannt oder nicht für den Key lesbar (Open WebUI meldet beides als 404).';
	}
	return '';
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** JSON.parse ohne Wurf — der Aufrufer entscheidet, was ein Fehler ist. */
export function parseJson(text: string): ParseResult {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ---------------------------------------------------------------- multipart

export interface MultipartFile {
	data: Buffer;
	filename: string;
	contentType: string;
}

export interface MultipartPart {
	name: string;
	value: string | MultipartFile;
}

/**
 * Baut einen multipart/form-data-Body als Buffer.
 *
 * Warum von Hand und nicht über `FormData`: n8n übernimmt Header nur aus dem
 * Paket `form-data`, und das ist für Community-Nodes per Lint verboten. Ein
 * fertiger Buffer mit eigenem Content-Type ist der einzige Weg, der ohne
 * Annahmen über n8n- und axios-Interna auskommt.
 */
export function buildMultipart(
	parts: MultipartPart[],
	boundary = `----n8nOpenWebUi${randomBytes(12).toString('hex')}`,
): { body: Buffer; contentType: string } {
	const chunks: Buffer[] = [];
	for (const part of parts) {
		const name = headerValue(part.name);
		if (typeof part.value === 'string') {
			chunks.push(
				Buffer.from(
					`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`,
					'utf8',
				),
				Buffer.from(part.value, 'utf8'),
				Buffer.from('\r\n', 'utf8'),
			);
			continue;
		}
		chunks.push(
			Buffer.from(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${name}"; filename="${headerValue(part.value.filename)}"\r\n` +
					`Content-Type: ${part.value.contentType}\r\n\r\n`,
				'utf8',
			),
			part.value.data,
			Buffer.from('\r\n', 'utf8'),
		);
	}
	chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
	return {
		body: Buffer.concat(chunks),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

/** Anführungszeichen und Zeilenumbrüche würden den Part-Header brechen. */
function headerValue(value: string): string {
	return value.replace(/[\r\n]+/g, ' ').replace(/"/g, '%22');
}
