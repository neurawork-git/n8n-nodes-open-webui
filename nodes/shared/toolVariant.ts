import type { INodeProperties, INodePropertyOptions, INodeTypeDescription } from 'n8n-workflow';

/**
 * Baut aus der Beschreibung einer Workflow-Node eine gefilterte Tool-Variante.
 *
 * Warum überhaupt zwei Varianten: ein Agent wählt aus dem, was er sieht. Liegt
 * eine Löschoperation im selben Werkzeug wie eine Leseoperation, ist Löschen in
 * jedem Reasoning-Schritt eine Option. Die Trennung ist eine Rechteschranke,
 * kein Feintuning der Beschreibung. Spezifikation: `docs/TOOL_NODES.md`. Übernommen aus
 * `n8n-nodes-neurawork`; `methods` setzt jede Variante selbst (siehe dort).
 *
 * Die Variante trägt **keine** eigene `execute`-Logik — sie liefert nur eine
 * gefilterte `description`. Entfernt werden nicht erlaubte Operationen samt der
 * Parameter, die nur über `displayOptions` an ihnen hängen.
 */
export interface ToolVariantOptions {
	/** Registrierter Node-Typ, z. B. `excelGraphRead`. n8n hängt `Tool` an. */
	name: string;
	displayName: string;
	/** Erlaubte `resource:operation`-Paare. */
	allow: string[];
	/** Zweck **und** Grenze, in zwei Sätzen. Wird Teil des Agent-Prompts. */
	description: string;
}

export function toolVariant(
	base: INodeTypeDescription,
	options: ToolVariantOptions,
): INodeTypeDescription {
	const allowed = new Map<string, Set<string>>();
	for (const pair of options.allow) {
		const [resource, operation] = pair.split(':');
		if (!allowed.has(resource)) allowed.set(resource, new Set());
		allowed.get(resource)!.add(operation);
	}
	const allOperations = new Set([...allowed.values()].flatMap((set) => [...set]));

	const properties = base.properties
		.map((property) => filterProperty(property, allowed, allOperations))
		.filter((property): property is INodeProperties => property !== undefined);

	return {
		...base,
		name: options.name,
		displayName: options.displayName,
		description: options.description,
		defaults: { ...base.defaults, name: options.displayName },
		usableAsTool: { replacements: { description: options.description } },
		properties,
	};
}

function filterProperty(
	property: INodeProperties,
	allowed: Map<string, Set<string>>,
	allOperations: Set<string>,
): INodeProperties | undefined {
	const copy: INodeProperties = JSON.parse(JSON.stringify(property));
	const show = copy.displayOptions?.show as Record<string, unknown[]> | undefined;

	if (copy.name === 'resource') {
		return narrowOptions(copy, (option) => allowed.has(String(option.value)));
	}

	// Ein Parameter, der nur unter nicht erlaubten Ressourcen erscheint, fällt weg.
	if (show?.resource) {
		const resources = (show.resource as string[]).filter((resource) => allowed.has(resource));
		if (resources.length === 0) return undefined;
		show.resource = resources;

		if (copy.name === 'operation') {
			const permitted = new Set(resources.flatMap((resource) => [...allowed.get(resource)!]));
			return narrowOptions(copy, (option) => permitted.has(String(option.value)));
		}
	}

	if (show?.operation) {
		const operations = (show.operation as string[]).filter((operation) =>
			allOperations.has(operation),
		);
		if (operations.length === 0) return undefined;
		show.operation = operations;
	}

	return copy;
}

/**
 * Filtert die Auswahlliste. Der Default der Basis-Node bleibt, solange er noch
 * erlaubt ist; nur sonst rückt die erste verbliebene Option nach.
 */
function narrowOptions(
	property: INodeProperties,
	keep: (option: INodePropertyOptions) => boolean,
): INodeProperties | undefined {
	const options = ((property.options ?? []) as INodePropertyOptions[]).filter(keep);
	if (options.length === 0) return undefined;
	const keepDefault = options.some((option) => option.value === property.default);
	return { ...property, options, default: keepDefault ? property.default : options[0].value };
}
