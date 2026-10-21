import { fileCountLabel, getKnowledgeBases, searchFiles, searchModels } from '../../nodes/OpenWebUi/methods';
import { callTo, mockLoadOptionsFunctions, type RequestOptions } from '../helpers/mockExecute';

const MODELS = {
	statusCode: 200,
	body: {
		data: [
			{ id: 'low', name: 'low' },
			{ id: 'medium', name: 'medium' },
			{ id: 'zz-preset', name: 'Beratungsauswerter', preset: true, info: { base_model_id: 'medium' } },
			{ id: 'alt', name: 'Altes Preset', preset: true, info: { base_model_id: 'gpt-5.6-luna' } },
		],
	},
};

describe('searchModels', () => {
	it('zeigt Presets zuerst, markiert defekte und liefert die ID als Wert', async () => {
		const context = mockLoadOptionsFunctions({ httpResponse: MODELS });
		const { results } = await searchModels.call(context);
		expect(results).toEqual([
			{ name: '⚠ defekt · Preset · Altes Preset (→ gpt-5.6-luna fehlt)', value: 'alt', description: undefined },
			{ name: 'Preset · Beratungsauswerter (→ medium)', value: 'zz-preset', description: undefined },
			{ name: 'Base · low', value: 'low', description: undefined },
			{ name: 'Base · medium', value: 'medium', description: undefined },
		]);
		expect(context.__httpMock.mock.calls[0][0]).toBe('openWebUiApi');
	});

	it('filtert über ID und Name', async () => {
		const context = mockLoadOptionsFunctions({ httpResponse: MODELS });
		const { results } = await searchModels.call(context, 'beratung');
		expect(results.map((result) => result.value)).toEqual(['zz-preset']);
	});

	it('reicht einen OWUI-Fehler durch, statt eine leere Liste zu zeigen', async () => {
		const context = mockLoadOptionsFunctions({
			httpResponse: { statusCode: 401, body: { detail: 'Not authenticated' } },
		});
		await expect(searchModels.call(context)).rejects.toThrow(/401.*API-Key/s);
	});
});

describe('getKnowledgeBases', () => {
	it('liest alle Seiten und zeigt die Dateizahl', async () => {
		const context = mockLoadOptionsFunctions({
			httpResponse: (_credential: string, options: RequestOptions) => {
				const page = Number(options.qs?.page);
				const items =
					page === 1
						? Array.from({ length: 30 }, (_, index) => ({ id: `kb${index}`, name: `KB ${String(index).padStart(2, '0')}`, file_count: index }))
						: [{ id: 'kb-last', name: 'Zuletzt', file_count: 1, description: 'Letzte Seite' }];
				return { statusCode: 200, body: { items, total: 31 } };
			},
		});
		const options = await getKnowledgeBases.call(context);
		expect(options).toHaveLength(31);
		expect(options[0]).toEqual({ name: 'KB 00 (0 Dateien)', value: 'kb0', description: undefined });
		expect(options.find((option) => option.value === 'kb-last')).toEqual({
			name: 'Zuletzt (1 Datei)',
			value: 'kb-last',
			description: 'Letzte Seite',
		});
		expect(context.__httpMock).toHaveBeenCalledTimes(2);
	});

	it('beschriftet unbekannte Dateizahlen ehrlich', () => {
		expect(fileCountLabel(null)).toBe('? Dateien');
		expect(fileCountLabel(2)).toBe('2 Dateien');
	});
});

describe('searchFiles', () => {
	it('macht aus der Eingabe eine Teilsuche und zeigt den Status', async () => {
		const context = mockLoadOptionsFunctions({
			httpResponse: {
				statusCode: 200,
				body: [{ id: 'f1', filename: 'protokoll.pdf', data: { status: 'completed' } }],
			},
		});
		const { results } = await searchFiles.call(context, 'protokoll');
		expect(results).toEqual([{ name: 'protokoll.pdf · completed', value: 'f1' }]);
		expect(callTo(context, '/api/v1/files/search')?.qs).toEqual({
			filename: '*protokoll*',
			content: false,
			limit: 100,
		});
	});
});
