/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/test'],
	testMatch: ['**/*.test.ts'],
	collectCoverageFrom: ['nodes/**/*.ts', 'credentials/**/*.ts'],
	// E2E (test/e2e/**) läuft nur über jest.e2e.config.js im opt-in-Job der CI.
	testPathIgnorePatterns: ['<rootDir>/test/e2e/'],
};
