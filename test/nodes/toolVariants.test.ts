import type { INodeProperties, INodePropertyOptions, INodeType } from 'n8n-workflow';

import { OpenWebUi } from '../../nodes/OpenWebUi/OpenWebUi.node';
import { OpenWebUiRead, OWUI_READ_OPERATIONS } from '../../nodes/OpenWebUi/OpenWebUiRead.node';
import { OpenWebUiWrite, OWUI_WRITE_OPERATIONS } from '../../nodes/OpenWebUi/OpenWebUiWrite.node';

const base = new OpenWebUi();
const read = new OpenWebUiRead();
const write = new OpenWebUiWrite();

/** Alle `resource:operation`-Paare, die eine Beschreibung anbietet — sortiert. */
function operationPairs(properties: INodeProperties[]): string[] {
	const pairs: string[] = [];
	for (const property of properties) {
		if (property.name !== 'operation') continue;
		const resources = (property.displayOptions?.show?.resource ?? []) as string[];
		for (const resource of resources) {
			for (const option of (property.options ?? []) as INodePropertyOptions[]) {
				pairs.push(`${resource}:${String(option.value)}`);
			}
		}
	}
	return pairs.sort();
}

/** Jede in den Properties referenzierte Auswahlliste, auch in Resource-Locator-Modi und Collections. */
function referencedMethods(properties: INodeProperties[]): { listSearch: string[]; loadOptions: string[] } {
	const listSearch = new Set<string>();
	const loadOptions = new Set<string>();
	const visit = (property: INodeProperties) => {
		const loadOptionsMethod = property.typeOptions?.loadOptionsMethod;
		if (typeof loadOptionsMethod === 'string') loadOptions.add(loadOptionsMethod);
		for (const mode of property.modes ?? []) {
			const searchListMethod = mode.typeOptions?.searchListMethod;
			if (typeof searchListMethod === 'string') listSearch.add(searchListMethod);
		}
		for (const option of (property.options ?? []) as Array<INodeProperties | INodePropertyOptions>) {
			if ('type' in option && 'displayName' in option) visit(option as INodeProperties);
		}
	};
	properties.forEach(visit);
	return { listSearch: [...listSearch].sort(), loadOptions: [...loadOptions].sort() };
}

describe('Tool-Varianten', () => {
	it('deckt jede Operation der Workflow-Node genau einmal ab (R3)', () => {
		const union = [...OWUI_READ_OPERATIONS, ...OWUI_WRITE_OPERATIONS].sort();
		expect(union).toEqual(operationPairs(base.description.properties));
		expect(union).toHaveLength(new Set(union).size);
	});

	it('hält Lese- und Schreibmenge disjunkt (R2)', () => {
		const overlap = OWUI_READ_OPERATIONS.filter((pair) => OWUI_WRITE_OPERATIONS.includes(pair));
		expect(overlap).toEqual([]);
	});

	it('führt in den Varianten wirklich nur die zugeordneten Operationen', () => {
		expect(operationPairs(read.description.properties)).toEqual([...OWUI_READ_OPERATIONS].sort());
		expect(operationPairs(write.description.properties)).toEqual([...OWUI_WRITE_OPERATIONS].sort());
	});

	it('wirft die Parameter weg, die nur an entfernten Operationen hingen', () => {
		const readNames = read.description.properties.map((property) => property.name);
		expect(readNames).toContain('model');
		expect(readNames).toContain('query');
		expect(readNames).not.toContain('uploadKnowledgeBaseId');
		expect(readNames).not.toContain('knowledgeName');
		expect(readNames).not.toContain('waitForProcessing');

		const writeNames = write.description.properties.map((property) => property.name);
		expect(writeNames).not.toContain('model');
		expect(writeNames).not.toContain('chatOptions');
		const resources = write.description.properties.find((property) => property.name === 'resource');
		expect((resources?.options as INodePropertyOptions[]).map((option) => option.value)).toEqual([
			'file',
			'knowledge',
		]);
	});

	it('behält den Default der Basis-Node, solange er erlaubt ist', () => {
		const resource = read.description.properties.find((property) => property.name === 'resource');
		expect(resource?.default).toBe('chat');
		const modelOperation = read.description.properties.find(
			(property) =>
				property.name === 'operation' &&
				((property.displayOptions?.show?.resource ?? []) as string[]).includes('model'),
		);
		expect(modelOperation?.default).toBe('getMany');
		// In der Schreib-Variante fehlt 'chat' — dort rückt die erste erlaubte Ressource nach.
		const writeResource = write.description.properties.find((property) => property.name === 'resource');
		expect(writeResource?.default).toBe('file');
	});

	it('nennt in beiden Beschreibungen Zweck und Grenze (R4)', () => {
		expect(read.description.usableAsTool).toEqual({
			replacements: { description: read.description.description },
		});
		expect(read.description.description).toMatch(/Kann nichts hochladen, anlegen/);
		expect(write.description.description).toMatch(/Ändert Daten in Open WebUI/);
		expect(read.description.name).toBe('openWebUiRead');
		expect(write.description.name).toBe('openWebUiWrite');
	});

	it('bietet die Workflow-Node nicht als Werkzeug an', () => {
		expect(base.description.usableAsTool).toBeUndefined();
	});

	it('teilt sich die Implementierung mit der Workflow-Node (R1)', () => {
		expect(read.execute).toBe(OpenWebUi.prototype.execute);
		expect(write.execute).toBe(OpenWebUi.prototype.execute);
	});

	it('gibt beiden Varianten dieselben methods wie der Workflow-Node', () => {
		for (const variant of [read, write]) {
			expect(variant.methods?.listSearch?.searchModels).toBe(base.methods?.listSearch?.searchModels);
			expect(variant.methods?.listSearch?.searchFiles).toBe(base.methods?.listSearch?.searchFiles);
			expect(variant.methods?.loadOptions?.getKnowledgeBases).toBe(
				base.methods?.loadOptions?.getKnowledgeBases,
			);
		}
	});

	it.each<[string, INodeType]>([
		['Workflow-Node', base],
		['Lesen', read],
		['Schreiben', write],
	])('%s: jede referenzierte Auswahlliste existiert in methods', (_name, node) => {
		const referenced = referencedMethods(node.description.properties);
		for (const method of referenced.listSearch) {
			expect(typeof node.methods?.listSearch?.[method]).toBe('function');
		}
		for (const method of referenced.loadOptions) {
			expect(typeof node.methods?.loadOptions?.[method]).toBe('function');
		}
	});

	it('findet die Auswahllisten tatsächlich (Probe des Tests)', () => {
		expect(referencedMethods(base.description.properties)).toEqual({
			listSearch: ['searchFiles', 'searchModels'],
			loadOptions: ['getKnowledgeBases'],
		});
	});
});
