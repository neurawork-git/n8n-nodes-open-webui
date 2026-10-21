import type { IExecuteFunctions, ILoadOptionsFunctions, INodeExecutionData } from 'n8n-workflow';

/** Was der Mock von `httpRequestWithAuthentication` zurückgibt (`returnFullResponse`). */
export interface MockResponse {
	statusCode: number;
	body?: unknown;
	headers?: Record<string, string>;
}

/** Die Optionen, die die Node an `httpRequestWithAuthentication` übergibt. */
export interface RequestOptions {
	method: string;
	url: string;
	qs?: Record<string, unknown>;
	headers?: Record<string, string>;
	body?: unknown;
	json?: boolean;
	encoding?: string;
	timeout?: number;
	returnFullResponse?: boolean;
	ignoreHttpStatusErrors?: boolean;
}

export type HttpHandler = (credential: string, options: RequestOptions) => MockResponse;

export interface MockConfig {
	nodeParameters: Record<string, unknown>;
	items?: INodeExecutionData[];
	credentials?: Record<string, unknown>;
	/** Feste Antwort oder Handler je Anfrage. */
	httpResponse?: MockResponse | HttpHandler;
	continueOnFail?: boolean;
	binaryData?: { fileName?: string; mimeType?: string; buffer?: Buffer };
}

export interface MockContext extends IExecuteFunctions {
	__httpMock: jest.Mock<Promise<MockResponse>, [string, RequestOptions]>;
	__prepareBinaryMock: jest.Mock;
}

export interface MockLoadOptionsContext extends ILoadOptionsFunctions {
	__httpMock: jest.Mock<Promise<MockResponse>, [string, RequestOptions]>;
}

const DEFAULT_CREDENTIALS = { baseUrl: 'http://open-webui.test', apiKey: 'test-key' };

/** Alle Anfragen eines Mocks als `[credential, options]`. */
export function calls(mock: MockContext | MockLoadOptionsContext): Array<[string, RequestOptions]> {
	return mock.__httpMock.mock.calls;
}

/** Die erste Anfrage, deren URL auf `suffix` endet (Query liegt in `qs`). */
export function callTo(
	mock: MockContext | MockLoadOptionsContext,
	suffix: string,
): RequestOptions | undefined {
	return calls(mock).find(([, options]) => options.url.endsWith(suffix))?.[1];
}

function httpMock(config: { httpResponse?: MockResponse | HttpHandler }) {
	return jest.fn(async (credential: string, options: RequestOptions): Promise<MockResponse> => {
		const response = config.httpResponse;
		if (response === undefined) throw new Error(`Unerwartete Anfrage: ${options.method} ${options.url}`);
		return typeof response === 'function' ? response(credential, options) : response;
	});
}

/**
 * Minimaler IExecuteFunctions-Mock. Statt echtem HTTP wird
 * `helpers.httpRequestWithAuthentication` gemockt; die Node setzt
 * `returnFullResponse` und `ignoreHttpStatusErrors`, deshalb antwortet der
 * Mock mit `{ statusCode, body, headers }`.
 */
export function mockExecuteFunctions(config: MockConfig): MockContext {
	const items = config.items ?? [{ json: {} }];
	const http = httpMock(config);
	const prepareBinary = jest.fn(async (buffer: Buffer, fileName: string, mimeType: string) => ({
		data: buffer.toString('base64'),
		fileName,
		mimeType,
	}));

	const context = {
		getInputData: () => items,
		// Dritter Parameter = Default wie in n8n. Ohne ihn muss der Parameter
		// definiert sein — sonst fällt ein Tippfehler im Namen erst live auf.
		getNodeParameter: (
			name: string,
			_itemIndex: number,
			fallback?: unknown,
			options?: { extractValue?: boolean },
		) => {
			if (!(name in config.nodeParameters)) {
				if (fallback !== undefined) return fallback;
				throw new Error(`mockExecuteFunctions: kein Parameter '${name}' definiert`);
			}
			const value = config.nodeParameters[name];
			if (options?.extractValue && value && typeof value === 'object' && 'value' in value) {
				return (value as { value: unknown }).value;
			}
			return value;
		},
		getCredentials: async () => config.credentials ?? DEFAULT_CREDENTIALS,
		getNode: () => ({
			id: 'node-1',
			name: 'Open WebUI',
			type: 'n8n-nodes-open-webui.openWebUi',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => config.continueOnFail ?? false,
		helpers: {
			httpRequestWithAuthentication: http,
			prepareBinaryData: prepareBinary,
			assertBinaryData: () => ({
				fileName: config.binaryData?.fileName,
				mimeType: config.binaryData?.mimeType,
			}),
			getBinaryDataBuffer: async () => config.binaryData?.buffer ?? Buffer.from('binary-input'),
		},
	} as unknown as MockContext;

	context.__httpMock = http;
	context.__prepareBinaryMock = prepareBinary;
	return context;
}

/** Mock für `ILoadOptionsFunctions` — Auswahllisten und Resource-Locator. */
export function mockLoadOptionsFunctions(config: {
	credentials?: Record<string, unknown>;
	httpResponse?: MockResponse | HttpHandler;
}): MockLoadOptionsContext {
	const http = httpMock(config);
	const context = {
		getCredentials: async () => config.credentials ?? DEFAULT_CREDENTIALS,
		getNode: () => ({
			id: 'node-1',
			name: 'Open WebUI',
			type: 'n8n-nodes-open-webui.openWebUi',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getNodeParameter: () => undefined,
		getCurrentNodeParameter: () => undefined,
		helpers: { httpRequestWithAuthentication: http },
	} as unknown as MockLoadOptionsContext;
	context.__httpMock = http;
	return context;
}
