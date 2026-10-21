import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

/**
 * API-Key eines Open-WebUI-Nutzers.
 *
 * Rechte steuert Open WebUI über den Nutzer hinter dem Key: Ein eigener
 * Dienstnutzer mit Rolle „user“ sieht nur die Modelle, Presets und
 * Wissensdatenbanken, die für ihn freigegeben sind.
 *
 * Der Test trifft `GET /api/v1/knowledge/?page=1`: billig und wie alle
 * Endpunkte der Node hinter `get_verified_user`. So scheitert er auch bei einem
 * Key, dessen Nutzer noch die Rolle „pending“ hat — `GET /api/v1/auths/` prüft
 * die Rolle nicht und wäre dort grün, obwohl jeder echte Aufruf mit 401 endet.
 */
export class OpenWebUiApi implements ICredentialType {
	name = 'openWebUiApi';

	displayName = 'Open WebUI API';

	icon: Icon = {
		light: 'file:../nodes/OpenWebUi/openWebUi.svg',
		dark: 'file:../nodes/OpenWebUi/openWebUi.svg',
	};

	documentationUrl = 'https://github.com/NeuraMax/n8n-nodes-open-webui#credential';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'e.g. http://open-webui.my-namespace.svc.cluster.local:8080',
			description:
				'Wurzel-URL von Open WebUI ohne Pfad. Im Cluster die interne Service-URL, damit lange RAG-Antworten nicht in den Ingress-Timeout laufen.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'API-Key aus Open WebUI (Einstellungen → Konto → API-Schlüssel), beginnt mit sk-. Wird als Bearer-Token gesendet.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
			url: '/api/v1/knowledge/',
			qs: { page: 1 },
		},
	};
}
