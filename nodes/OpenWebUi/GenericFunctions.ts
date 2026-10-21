import {
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
} from 'n8n-workflow';

import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	OwuiClient,
	type OwuiHttpRequest,
	type OwuiHttpResponse,
} from './transport';

/** Name der Credential — Node, Varianten und Auswahllisten nutzen dieselbe. */
export const OWUI_CREDENTIAL = 'openWebUiApi';

/**
 * Verbindet den transportfreien Kern mit n8n: Anmeldung über
 * `httpRequestWithAuthentication`, Warten über `sleep` aus `n8n-workflow`.
 *
 * `ignoreHttpStatusErrors` ist Pflicht — sonst wirft n8n vor dem Kern, und die
 * Fehlerübersetzung mit `detail`, Endpunkt und Hinweis greift nie. Fehler ohne
 * Antwort (Timeout, Netz) übersetzt `OwuiClient.send` mit Endpunkt.
 */
export async function createClient(
	context: IExecuteFunctions | ILoadOptionsFunctions,
): Promise<OwuiClient> {
	const credentials = await context.getCredentials(OWUI_CREDENTIAL);
	return new OwuiClient({
		baseUrl: String(credentials.baseUrl ?? ''),
		sleep: async (ms: number) => await sleep(ms),
		http: async (request: OwuiHttpRequest): Promise<OwuiHttpResponse> => {
			const options: IHttpRequestOptions = {
				method: request.method,
				url: request.url,
				qs: request.qs as IDataObject | undefined,
				headers: request.headers,
				body: request.rawBody ?? (request.body as IDataObject | undefined),
				json: !request.binary,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
				...(request.binary ? { encoding: 'arraybuffer' as const } : {}),
			};
			const response = (await context.helpers.httpRequestWithAuthentication.call(
				context,
				OWUI_CREDENTIAL,
				options,
			)) as { statusCode: number; body: unknown; headers?: Record<string, string> };
			return {
				status: response.statusCode,
				body: response.body,
				headers: response.headers ?? {},
			};
		},
	});
}
