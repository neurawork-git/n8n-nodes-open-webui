/**
 * E2E gegen einen echten Open-WebUI-Container (CI-Job `e2e-owui`).
 *
 * Die Umgebung wird hier gelesen und als Jest-Global übergeben: Testcode unter
 * `test/` fällt unter den n8n-Community-Lint, der `process` verbietet.
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/test/e2e'],
	testMatch: ['**/*.e2e.test.ts'],
	testTimeout: 300000,
	globals: {
		OWUI_E2E: {
			baseUrl: process.env.OWUI_E2E_BASE_URL ?? '',
			apiKey: process.env.OWUI_E2E_API_KEY ?? '',
			model: process.env.OWUI_E2E_MODEL ?? '',
		},
	},
};
