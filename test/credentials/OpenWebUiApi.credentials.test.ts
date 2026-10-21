import { OpenWebUiApi } from '../../credentials/OpenWebUiApi.credentials';
import { OpenWebUi } from '../../nodes/OpenWebUi/OpenWebUi.node';

const credential = new OpenWebUiApi();

describe('OpenWebUiApi', () => {
	it('heißt so, wie die Node sie anfordert', () => {
		expect(credential.name).toBe('openWebUiApi');
		expect(new OpenWebUi().description.credentials?.[0]).toEqual({ name: 'openWebUiApi', required: true });
	});

	it('sendet den Key als Bearer-Token', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
		});
	});

	it('testet gegen einen Endpunkt mit Rollenprüfung (get_verified_user), ohne doppelten Slash', () => {
		// /api/v1/auths/ prüft die Rolle nicht: Ein Key mit Rolle „pending“ wäre grün.
		expect(credential.test.request.url).toBe('/api/v1/knowledge/');
		expect(credential.test.request.qs).toEqual({ page: 1 });
		expect(credential.test.request.baseURL).toBe('={{$credentials.baseUrl.replace(/\\/+$/, "")}}');
	});

	it('führt den Key als Passwortfeld', () => {
		const apiKey = credential.properties.find((property) => property.name === 'apiKey');
		expect(apiKey?.typeOptions?.password).toBe(true);
	});

	it('beschreibt jedes Feld mit mehr als einem Stichwort', () => {
		for (const property of credential.properties) {
			expect((property.description ?? '').length).toBeGreaterThan(20);
		}
	});
});
