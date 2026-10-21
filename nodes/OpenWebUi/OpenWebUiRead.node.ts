import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

import { owuiMethods } from './methods';
import { OpenWebUi } from './OpenWebUi.node';
import { toolVariant } from '../shared/toolVariant';

/**
 * Nur lesende Operationen — siehe `docs/TOOL_NODES.md`. Zuordnung nach Wirkung
 * in Open WebUI, nicht nach HTTP-Methode: Chat und Suche sind `POST`, ändern
 * aber nichts.
 */
export const OWUI_READ_OPERATIONS = [
	'chat:complete',
	'model:getMany',
	'model:get',
	'knowledge:getMany',
	'knowledge:get',
	'knowledge:search',
	'file:get',
	'file:getMany',
	'file:download',
	'audio:transcribe',
];

// Das Icon kommt über toolVariant aus OpenWebUi.description; die Regel erkennt nur Objekt-Literale.
// eslint-disable-next-line @n8n/community-nodes/icon-validation
export class OpenWebUiRead implements INodeType {
	description: INodeTypeDescription = toolVariant(new OpenWebUi().description, {
		name: 'openWebUiRead',
		displayName: 'Open WebUI (Lesen)',
		allow: OWUI_READ_OPERATIONS,
		description:
			'Fragt Modelle und Presets in Open WebUI an, durchsucht Wissensdatenbanken und liest ' +
			'Dateien. Kann nichts hochladen, anlegen oder einer Wissensdatenbank hinzufügen — dafür ' +
			'gibt es das Schreib-Werkzeug.',
	});

	// Genau eine Implementierung im Paket (R1): die Variante delegiert.
	execute = OpenWebUi.prototype.execute;

	// Ohne `methods` blieben „Aus Liste“ und Dropdowns im Werkzeug leer.
	methods = owuiMethods;
}
