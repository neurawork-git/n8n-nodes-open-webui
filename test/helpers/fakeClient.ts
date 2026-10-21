import {
	OwuiClient,
	type OwuiHttpRequest,
	type OwuiHttpResponse,
} from '../../nodes/OpenWebUi/transport';

export type Route = (request: OwuiHttpRequest) => Partial<OwuiHttpResponse> | undefined;

export interface FakeClient {
	client: OwuiClient;
	requests: OwuiHttpRequest[];
	sleeps: number[];
	/** Stellt die virtuelle Uhr vor — z. B. für eine Anfrage, die selbst Zeit braucht. */
	tick: (ms: number) => void;
}

/**
 * Client gegen eine Liste von Routen. Die erste Route, die eine Antwort
 * liefert, gewinnt; eine Anfrage ohne passende Route ist ein Testfehler.
 * Die Uhr ist virtuell: Nur `sleep` und `tick` stellen sie vor.
 */
export function fakeClient(routes: Route[]): FakeClient {
	const requests: OwuiHttpRequest[] = [];
	const sleeps: number[] = [];
	let clock = 0;
	const tick = (ms: number) => {
		clock += ms;
	};
	const client = new OwuiClient({
		baseUrl: 'http://owui.test/',
		now: () => clock,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			tick(ms);
		},
		http: async (request) => {
			requests.push(request);
			for (const route of routes) {
				const response = route(request);
				if (response) return { status: 200, headers: {}, body: null, ...response };
			}
			throw new Error(`Keine Route für ${request.method} ${request.url}`);
		},
	});
	return { client, requests, sleeps, tick };
}

/** Route für Methode + exakten Pfad (ohne Query). */
export function on(
	method: 'GET' | 'POST',
	path: string,
	response: Partial<OwuiHttpResponse> | ((request: OwuiHttpRequest) => Partial<OwuiHttpResponse>),
): Route {
	return (request) => {
		if (request.method !== method || request.path !== path) return undefined;
		return typeof response === 'function' ? response(request) : response;
	};
}

/** Antwortet nacheinander mit den gegebenen Antworten; die letzte wiederholt sich. */
export function sequence(...responses: Array<Partial<OwuiHttpResponse>>) {
	let index = 0;
	return () => responses[Math.min(index++, responses.length - 1)];
}
