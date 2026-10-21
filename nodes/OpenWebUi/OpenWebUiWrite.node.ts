import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

import { owuiMethods } from './methods';
import { OpenWebUi } from './OpenWebUi.node';
import { toolVariant } from '../shared/toolVariant';

/**
 * Verändernde Operationen — siehe `docs/TOOL_NODES.md`. Löschen bietet der
 * Baustein gar nicht an; `removeFile` nimmt eine Datei nur aus der
 * Wissensdatenbank (`delete_file=false`).
 */
export const OWUI_WRITE_OPERATIONS = [
	'knowledge:create',
	'knowledge:addFile',
	'knowledge:removeFile',
	'file:upload',
];

// Das Icon kommt über toolVariant aus OpenWebUi.description; die Regel erkennt nur Objekt-Literale.
// eslint-disable-next-line @n8n/community-nodes/icon-validation
export class OpenWebUiWrite implements INodeType {
	description: INodeTypeDescription = toolVariant(new OpenWebUi().description, {
		name: 'openWebUiWrite',
		displayName: 'Open WebUI (Schreiben)',
		allow: OWUI_WRITE_OPERATIONS,
		description:
			'Lädt Dateien nach Open WebUI hoch, legt Wissensdatenbanken an und fügt ihnen Dateien ' +
			'hinzu oder nimmt sie heraus. Ändert Daten in Open WebUI; zum Nachsehen und Fragen gibt ' +
			'es das Lese-Werkzeug.',
	});

	// Genau eine Implementierung im Paket (R1): die Variante delegiert.
	execute = OpenWebUi.prototype.execute;

	// Ohne `methods` blieben „Aus Liste“ und Dropdowns im Werkzeug leer.
	methods = owuiMethods;
}
