import type {
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
	INodePropertyOptions,
	INodeType,
} from 'n8n-workflow';

import { createClient } from './GenericFunctions';
import {
	listKnowledgeBases,
	listModels,
	modelLabel,
	searchFiles as searchOwuiFiles,
	substringPattern,
	type OwuiModel,
} from './operations';

/** Wie viele Dateien „Aus Liste“ höchstens zeigt. */
const FILE_LIST_LIMIT = 100;

/**
 * Modelle und Presets für den Resource-Locator „Aus Liste“.
 *
 * Presets zuerst, dann Base-Modelle, jeweils nach Name. Ein Preset mit
 * verschwundenem Base-Modell bleibt sichtbar, aber als „⚠ defekt“ markiert —
 * ausblenden hieße, einen kaputten Workflow zu verstecken.
 */
export async function searchModels(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const client = await createClient(this);
	const models = await listModels(client);
	const needle = (filter ?? '').trim().toLowerCase();
	const results: INodeListSearchItems[] = models
		.filter(
			(model) =>
				needle === '' ||
				model.id.toLowerCase().includes(needle) ||
				model.name.toLowerCase().includes(needle),
		)
		.sort(compareModels)
		.map((model) => ({
			name: modelLabel(model),
			value: model.id,
			description: model.description ?? undefined,
		}));
	return { results };
}

function compareModels(a: OwuiModel, b: OwuiModel): number {
	if (a.type !== b.type) return a.type === 'preset' ? -1 : 1;
	return a.name.localeCompare(b.name, 'de');
}

/** Alle Wissensdatenbanken über alle Seiten, Anzeige `Name (n Dateien)`. */
export async function getKnowledgeBases(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	const client = await createClient(this);
	const knowledgeBases = await listKnowledgeBases(client);
	return knowledgeBases
		.map((knowledgeBase) => ({
			name: `${knowledgeBase.name} (${fileCountLabel(knowledgeBase.fileCount)})`,
			value: knowledgeBase.id,
			description: knowledgeBase.description || undefined,
		}))
		.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export function fileCountLabel(count: number | null): string {
	if (count === null) return '? Dateien';
	return count === 1 ? '1 Datei' : `${count} Dateien`;
}

/**
 * Dateien für den Resource-Locator. OWUI durchsucht dabei nur die **eigenen**
 * Dateien des Key-Nutzers; die Eingabe wird zur Teilsuche `*eingabe*`.
 */
export async function searchFiles(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const client = await createClient(this);
	const files = await searchOwuiFiles(client, substringPattern(filter), FILE_LIST_LIMIT);
	return {
		results: files.map((file) => ({
			name: file.status ? `${file.filename} · ${file.status}` : file.filename,
			value: file.id,
		})),
	};
}

/**
 * Eine Konstante, auf die Basis-Node **und** Tool-Varianten zeigen.
 *
 * `toolVariant()` kopiert nur die Beschreibung. Fehlt `methods` in einer
 * Variante, bleiben „Aus Liste“ und Dropdowns dort leer — ein Test prüft,
 * dass jede referenzierte Methode in jeder Variante existiert.
 */
export const owuiMethods = {
	listSearch: { searchModels, searchFiles },
	loadOptions: { getKnowledgeBases },
} satisfies INodeType['methods'];
