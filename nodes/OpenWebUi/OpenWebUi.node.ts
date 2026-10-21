import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IBinaryKeyData,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import { createClient } from './GenericFunctions';
import { owuiMethods } from './methods';
import {
	addFileToKnowledge,
	chatComplete,
	createKnowledgeBase,
	downloadFile,
	findModel,
	getFile,
	getKnowledgeBase,
	listKnowledgeBases,
	listModels,
	parseJsonObject,
	parseMessages,
	removeFileFromKnowledge,
	searchFiles,
	searchKnowledge,
	splitIds,
	toOptionalNumber,
	toRequireSources,
	toSeconds,
	toUploadInput,
	transcribe,
	uploadFile,
	type ChatChecks,
	type ChatInput,
	type OwuiModel,
	type UploadInput,
	type WaitOptions,
} from './operations';
import { OwuiClient, OwuiError } from './transport';

/** Gemeinsame Felder fürs Warten auf die Verarbeitung (Upload und Add File). */
const waitOptionsCollection = (operations: { resource: string; operation: string }): INodeProperties[] => [
	{
		displayName: 'Auf Verarbeitung Warten',
		name: 'waitForProcessing',
		type: 'boolean',
		default: true,
		displayOptions: { show: { resource: [operations.resource], operation: [operations.operation] } },
		description:
			'Whether to poll until Open WebUI has finished processing the file. Ohne Warten liefert Add File bei laufender Verarbeitung einen Fehler; ein Upload mit Wissensdatenbank verlangt das Warten.',
	},
	{
		displayName: 'Warten',
		name: 'waitOptions',
		type: 'collection',
		placeholder: 'Option hinzufügen',
		default: {},
		displayOptions: {
			show: {
				resource: [operations.resource],
				operation: [operations.operation],
				waitForProcessing: [true],
			},
		},
		options: [
			{
				displayName: 'Abfrageintervall in Sekunden',
				name: 'interval',
				type: 'number',
				default: 2,
				typeOptions: { minValue: 1 },
				description: 'Abstand zwischen zwei Statusabfragen',
			},
			{
				displayName: 'Timeout in Sekunden',
				name: 'timeout',
				type: 'number',
				default: 300,
				typeOptions: { minValue: 1 },
				description: 'So lange wird höchstens gewartet. Danach bricht die Node mit der Datei-ID ab.',
			},
		],
	},
];

const fileLocator = (show: { resource: string[]; operation: string[] }): INodeProperties => ({
	displayName: 'Datei',
	name: 'fileId',
	type: 'resourceLocator',
	required: true,
	default: { mode: 'list', value: '' },
	displayOptions: { show },
	description:
		'Datei in Open WebUI. Die Liste zeigt nur eigene Dateien des Key-Nutzers; fremde, freigegebene Dateien über die ID wählen.',
	modes: [
		{
			displayName: 'Aus Liste',
			name: 'list',
			type: 'list',
			typeOptions: { searchListMethod: 'searchFiles', searchable: true },
		},
		{
			displayName: 'ID',
			name: 'id',
			type: 'string',
			placeholder: 'z. B. 3f2c9a6e-…',
		},
	],
});

/**
 * n8n-Node für Open WebUI.
 *
 * Diese Klasse ist nur die Hülle: Parameter einsammeln, den Client mit
 * n8n-Transport bauen, Ergebnisse in Items wandeln, Fehler übersetzen. Die
 * Logik liegt n8n-frei in `operations.ts` und `transport.ts`.
 *
 * `usableAsTool` fehlt hier bewusst: Als Werkzeug für KI-Agenten gibt es nur die
 * Varianten „Lesen“ und „Schreiben“ (`docs/TOOL_NODES.md`). Mit `true` erzeugte
 * n8n zusätzlich ein Werkzeug mit vollem Zugriff, und `false` lässt der Typ
 * `INodeTypeDescription` nicht zu.
 */
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class OpenWebUi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Open WebUI',
		name: 'openWebUi',
		icon: { light: 'file:openWebUi.svg', dark: 'file:openWebUi.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Chat mit Modellen und Presets, Wissensdatenbanken, Dateien und Audio in Open WebUI',
		defaults: {
			name: 'Open WebUI',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'openWebUiApi',
				required: true,
			},
		],
		properties: [
			// ------------------------------------------------ Ressource
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Audio', value: 'audio' },
					{ name: 'Chat', value: 'chat' },
					{ name: 'File', value: 'file' },
					{ name: 'Knowledge', value: 'knowledge' },
					{ name: 'Model', value: 'model' },
				],
				default: 'chat',
			},

			// ------------------------------------------------ Operationen
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['chat'] } },
				options: [
					{
						name: 'Complete',
						value: 'complete',
						action: 'Complete a chat',
						description:
							'Schickt einen Prompt an ein Modell oder Preset, optional mit Wissensdatenbanken und Dateien als Quellen',
					},
				],
				default: 'complete',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['model'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						action: 'Get a model',
						description:
							'Liest ein Modell oder Preset samt Base-Modell und angehängten Wissensdatenbanken',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'Get many models',
						description: 'Listet Modelle und Presets, die der API-Key sieht',
					},
				],
				default: 'getMany',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['knowledge'] } },
				options: [
					{
						name: 'Add File',
						value: 'addFile',
						action: 'Add a file to a knowledge base',
						description:
							'Hängt eine verarbeitete Datei an eine Wissensdatenbank. Wartet vorher auf das Ende der Verarbeitung.',
					},
					{
						name: 'Create',
						value: 'create',
						action: 'Create a knowledge base',
						description: 'Legt eine neue Wissensdatenbank an, privat für den Key-Nutzer',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a knowledge base',
						description: 'Liest eine Wissensdatenbank samt Dateiliste',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'Get many knowledge bases',
						description: 'Listet alle Wissensdatenbanken, die der API-Key sieht',
					},
					{
						name: 'Remove File',
						value: 'removeFile',
						action: 'Remove a file from a knowledge base',
						description:
							'Nimmt eine Datei aus einer Wissensdatenbank. Die Datei selbst bleibt in Open WebUI erhalten.',
					},
					{
						name: 'Search',
						value: 'search',
						action: 'Search a knowledge base',
						description: 'Semantische Suche in einer Wissensdatenbank, liefert Textstellen mit Score',
					},
				],
				default: 'search',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['file'] } },
				options: [
					{
						name: 'Download',
						value: 'download',
						action: 'Download a file',
						description: 'Lädt die Originaldatei als Binärdaten',
					},
					{
						name: 'Get',
						value: 'get',
						action: 'Get a file',
						description: 'Liest Metadaten und Verarbeitungsstatus einer Datei',
					},
					{
						name: 'Get Many',
						value: 'getMany',
						action: 'Get many files',
						description: 'Sucht eigene Dateien des Key-Nutzers über ein Dateinamensmuster',
					},
					{
						name: 'Upload',
						value: 'upload',
						action: 'Upload a file',
						description:
							'Lädt Binärdaten hoch, wartet auf die Verarbeitung und hängt die Datei optional an eine Wissensdatenbank',
					},
				],
				default: 'download',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['audio'] } },
				options: [
					{
						name: 'Transcribe',
						value: 'transcribe',
						action: 'Transcribe an audio file',
						description: 'Wandelt Audio aus Binärdaten über die Spracherkennung von Open WebUI in Text',
					},
				],
				default: 'transcribe',
			},

			// ------------------------------------------------ Modell (Chat und Model: Get)
			{
				displayName: 'Modell',
				name: 'model',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'list', value: '' },
				displayOptions: { show: { resource: ['chat', 'model'], operation: ['complete', 'get'] } },
				description:
					'Modell oder Preset aus Open WebUI. Vor dem Chat prüft die Node, dass es für den API-Key sichtbar ist.',
				modes: [
					{
						displayName: 'Aus Liste',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchModels', searchable: true },
					},
					{
						displayName: 'ID',
						name: 'id',
						type: 'string',
						placeholder: 'z. B. medium',
					},
				],
			},

			// ------------------------------------------------ Chat: Complete
			{
				displayName: 'Systemprompt',
				name: 'systemPrompt',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				displayOptions: { show: { resource: ['chat'], operation: ['complete'] } },
				description:
					'Optional. Open WebUI setzt den Systemprompt eines Presets davor, nicht stattdessen.',
			},
			{
				displayName: 'Eingabe',
				name: 'inputMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Messages (JSON)',
						value: 'messages',
						description: 'Ganzer Verlauf als Array aus role und content',
					},
					{ name: 'Prompt', value: 'prompt', description: 'Eine einzelne Nutzernachricht' },
				],
				default: 'prompt',
				displayOptions: { show: { resource: ['chat'], operation: ['complete'] } },
			},
			{
				displayName: 'Prompt',
				name: 'prompt',
				type: 'string',
				typeOptions: { rows: 6 },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['chat'], operation: ['complete'], inputMode: ['prompt'] },
				},
				description: 'Die Nachricht an das Modell',
			},
			{
				displayName: 'Messages',
				name: 'messages',
				type: 'json',
				required: true,
				default: '[\n  {\n    "role": "user",\n    "content": ""\n  }\n]',
				displayOptions: {
					show: { resource: ['chat'], operation: ['complete'], inputMode: ['messages'] },
				},
				description:
					'Array aus Nachrichten im OpenAI-Format. Ein Systemprompt oben wird davor gesetzt.',
			},
			{
				displayName: 'Knowledge Base Names or IDs',
				name: 'knowledgeBaseIds',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getKnowledgeBases' },
				default: [],
				displayOptions: { show: { resource: ['chat'], operation: ['complete'] } },
				description:
					'Wissensdatenbanken, die Open WebUI für die Antwort durchsucht. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Datei-IDs',
				name: 'fileIds',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['chat'], operation: ['complete'] } },
				description:
					'Optional. Einzelne Dateien als Quellen, mehrere durch Komma getrennt. Sie müssen fertig verarbeitet sein.',
			},
			{
				displayName: 'Optionen',
				name: 'chatOptions',
				type: 'collection',
				placeholder: 'Option hinzufügen',
				default: {},
				displayOptions: { show: { resource: ['chat'], operation: ['complete'] } },
				options: [
					{
						displayName: 'Antwortformat',
						name: 'responseFormat',
						type: 'json',
						default: '{\n  "type": "json_object"\n}',
						description:
							'Wird als response_format an das Modell gereicht. Für strukturiertes JSON zusammen mit „JSON Parsen“.',
					},
					{
						displayName: 'JSON Parsen',
						name: 'parseJson',
						type: 'boolean',
						default: false,
						description:
							'Whether to parse the answer as JSON into an extra output field. Ungültiges JSON ist ein Fehler mit den ersten 500 Zeichen.',
					},
					{
						displayName: 'Modell Abgleichen',
						name: 'checkModel',
						type: 'boolean',
						default: false,
						description:
							'Whether to fail when the response names a model other than the requested one or its base model (auch ohne Präfix der Verbindung). Open WebUI reicht durch, was der Anbieter meldet — Azure und LiteLLM melden oft Deployment- oder Snapshot-Namen, deshalb standardmäßig aus.',
					},
					{
						displayName: 'Quellen Erforderlich',
						name: 'requireSources',
						type: 'options',
						options: [
							{
								name: 'Automatisch',
								value: 'auto',
								description: 'Fehler ohne Quellen, sobald eine Wissensdatenbank oder Datei gewählt ist',
							},
							{
								name: 'Immer',
								value: 'always',
								description: 'Fehler, wenn die Antwort keine Quellen enthält',
							},
							{ name: 'Nie', value: 'never', description: 'Keine Prüfung der Quellen' },
						],
						default: 'auto',
						description:
							'Open WebUI überspringt Wissensdatenbanken und Dateien ohne Zugriff stillschweigend. Diese Prüfung macht das sichtbar.',
					},
					{
						displayName: 'Rohantwort Mitgeben',
						name: 'includeRaw',
						type: 'boolean',
						default: false,
						description:
							'Whether to include the full Open WebUI response in the field raw. Hilft beim Umstieg von Ausdrücken auf choices[0].',
					},
					{
						displayName: 'Temperatur',
						name: 'temperature',
						type: 'number',
						default: 1,
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
						description: 'Zufälligkeit der Antwort. Manche Modelle akzeptieren nur den Standardwert.',
					},
					{
						displayName: 'Timeout in Sekunden',
						name: 'timeout',
						type: 'number',
						default: 300,
						typeOptions: { minValue: 1 },
						description: 'So lange wartet die Node auf die Antwort. RAG-Antworten brauchen oft Minuten.',
					},
				],
			},

			// ------------------------------------------------ Model: Get Many
			{
				displayName: 'Typ',
				name: 'modelType',
				type: 'options',
				options: [
					{ name: 'Alle', value: 'all' },
					{ name: 'Base-Modelle', value: 'base' },
					{ name: 'Presets', value: 'preset' },
				],
				default: 'all',
				displayOptions: { show: { resource: ['model'], operation: ['getMany'] } },
				description: 'Welche Modelle geliefert werden',
			},

			// ------------------------------------------------ Knowledge
			{
				displayName: 'Knowledge Base Name or ID',
				name: 'knowledgeBaseId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getKnowledgeBases' },
				required: true,
				default: '',
				displayOptions: {
					show: { resource: ['knowledge'], operation: ['get', 'search', 'addFile', 'removeFile'] },
				},
				description:
					'Die Wissensdatenbank. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Suchanfrage',
				name: 'query',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['knowledge'], operation: ['search'] } },
				description: 'Wonach semantisch gesucht wird',
			},
			{
				displayName: 'Anzahl Treffer',
				name: 'topK',
				type: 'number',
				default: 5,
				typeOptions: { minValue: 1 },
				displayOptions: { show: { resource: ['knowledge'], operation: ['search'] } },
				description: 'Wie viele Textstellen höchstens geliefert werden',
			},
			{
				displayName: 'Name',
				name: 'knowledgeName',
				type: 'string',
				required: true,
				default: '',
				displayOptions: { show: { resource: ['knowledge'], operation: ['create'] } },
				description: 'Name der neuen Wissensdatenbank',
			},
			{
				displayName: 'Beschreibung',
				name: 'knowledgeDescription',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['knowledge'], operation: ['create'] } },
				description: 'Kurzbeschreibung. Open WebUI nutzt sie auch, um die Wissensdatenbank zu finden.',
			},
			fileLocator({ resource: ['knowledge'], operation: ['addFile', 'removeFile'] }),
			...waitOptionsCollection({ resource: 'knowledge', operation: 'addFile' }),

			// ------------------------------------------------ File
			fileLocator({ resource: ['file'], operation: ['get', 'download'] }),
			{
				displayName: 'Dateiname (Muster)',
				name: 'filenamePattern',
				type: 'string',
				default: '*',
				displayOptions: { show: { resource: ['file'], operation: ['getMany'] } },
				description:
					'Muster mit * und ?, z. B. *.pdf oder Protokoll*. Ohne Platzhalter sucht Open WebUI nur exakte Namen.',
			},
			{
				displayName: 'Maximale Anzahl',
				name: 'maxResults',
				type: 'number',
				default: 100,
				typeOptions: { minValue: 1, maxValue: 1000 },
				displayOptions: { show: { resource: ['file'], operation: ['getMany'] } },
				description: 'Wie viele Dateien höchstens geliefert werden (1 bis 1000)',
			},
			{
				displayName: 'Binärfeld',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: { show: { resource: ['file'], operation: ['download'] } },
				description: 'In dieses Binärfeld schreibt die Node die Datei',
			},
			{
				displayName: 'Binärfeld',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				displayOptions: {
					show: { resource: ['file', 'audio'], operation: ['upload', 'transcribe'] },
				},
				description: 'Aus diesem Binärfeld liest die Node die Datei',
			},
			{
				displayName: 'Dateiname',
				name: 'fileName',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				description: 'Optional. Überschreibt den Dateinamen aus den Binärdaten.',
			},
			{
				displayName: 'Knowledge Base Name or ID',
				name: 'uploadKnowledgeBaseId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getKnowledgeBases' },
				default: '',
				displayOptions: { show: { resource: ['file'], operation: ['upload'] } },
				description:
					'Optional. Nach der Verarbeitung wird die Datei dieser Wissensdatenbank hinzugefügt. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			...waitOptionsCollection({ resource: 'file', operation: 'upload' }),

			// ------------------------------------------------ Audio
			{
				displayName: 'Sprache',
				name: 'language',
				type: 'string',
				default: '',
				placeholder: 'de',
				displayOptions: { show: { resource: ['audio'], operation: ['transcribe'] } },
				description: 'Optional. Sprachcode nach ISO 639-1; leer erkennt die Sprache automatisch.',
			},
		],
	};

	methods = owuiMethods;

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const state: RunState = {};

		for (let i = 0; i < items.length; i++) {
			try {
				const results = await runOperation(this, state, i);
				for (const result of results) {
					out.push({
						json: result.json,
						...(result.binary ? { binary: result.binary } : {}),
						pairedItem: { item: i },
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: errorJson(error as Error), pairedItem: { item: i } });
					continue;
				}
				if (error instanceof OwuiError) {
					throw new NodeApiError(this.getNode(), error.toJSON() as JsonObject, {
						message: error.message,
						description: error.hint || undefined,
						httpCode: String(error.status),
						itemIndex: i,
					});
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [out];
	}
}

/** Pro Ausführung einmal: Client und Modellliste werden über Items hinweg geteilt. */
interface RunState {
	client?: OwuiClient;
	models?: OwuiModel[];
}

interface OperationResult {
	json: IDataObject;
	binary?: IBinaryKeyData;
}

function errorJson(error: Error): IDataObject {
	return {
		error: error.message,
		...(error instanceof OwuiError ? error.toJSON() : {}),
	};
}

function asJson(value: unknown): IDataObject {
	return value as IDataObject;
}

async function runOperation(
	context: IExecuteFunctions,
	state: RunState,
	index: number,
): Promise<OperationResult[]> {
	const resource = context.getNodeParameter('resource', index) as string;
	const operation = context.getNodeParameter('operation', index) as string;
	state.client ??= await createClient(context);
	const client = state.client;
	const models = async (): Promise<OwuiModel[]> => (state.models ??= await listModels(client));
	const param = (name: string) => context.getNodeParameter(name, index) as string;
	const locator = (name: string) =>
		String(context.getNodeParameter(name, index, undefined, { extractValue: true }) ?? '').trim();

	switch (`${resource}:${operation}`) {
		case 'chat:complete':
			return [{ json: asJson(await runChat(context, client, await models(), index)) }];

		case 'model:getMany': {
			const type = context.getNodeParameter('modelType', index, 'all') as string;
			return (await models())
				.filter((model) => type === 'all' || model.type === type)
				.map((model) => ({ json: asJson(model) }));
		}
		case 'model:get':
			return [{ json: asJson(findModel(await models(), locator('model'))) }];

		case 'knowledge:getMany':
			return (await listKnowledgeBases(client)).map((knowledgeBase) => ({
				json: asJson(knowledgeBase),
			}));
		case 'knowledge:get':
			return [{ json: asJson(await getKnowledgeBase(client, param('knowledgeBaseId'))) }];
		case 'knowledge:search': {
			const knowledgeBaseId = param('knowledgeBaseId');
			const query = param('query');
			const results = await searchKnowledge(
				client,
				knowledgeBaseId,
				query,
				context.getNodeParameter('topK', index, 5) as number,
			);
			return [{ json: asJson({ knowledgeBaseId, query, results }) }];
		}
		case 'knowledge:create':
			return [
				{
					json: asJson(
						await createKnowledgeBase(
							client,
							param('knowledgeName'),
							context.getNodeParameter('knowledgeDescription', index, '') as string,
						),
					),
				},
			];
		case 'knowledge:addFile':
			return [
				{
					json: asJson(
						await addFileToKnowledge(
							client,
							param('knowledgeBaseId'),
							locator('fileId'),
							waitOptions(context, index),
						),
					),
				},
			];
		case 'knowledge:removeFile':
			return [
				{
					json: asJson(
						await removeFileFromKnowledge(client, param('knowledgeBaseId'), locator('fileId')),
					),
				},
			];

		case 'file:get':
			return [{ json: asJson(await getFile(client, locator('fileId'))) }];
		case 'file:getMany':
			return (
				await searchFiles(
					client,
					context.getNodeParameter('filenamePattern', index, '*') as string,
					context.getNodeParameter('maxResults', index, 100) as number,
				)
			).map((file) => ({ json: asJson(file) }));
		case 'file:download': {
			const downloaded = await downloadFile(client, locator('fileId'));
			const property = param('binaryPropertyName');
			const binary = await context.helpers.prepareBinaryData(
				downloaded.data,
				downloaded.file.filename,
				downloaded.mimeType,
			);
			return [{ json: asJson(downloaded.file), binary: { [property]: binary } }];
		}
		case 'file:upload': {
			const input = await binaryInput(context, index);
			const knowledgeBaseId = (
				context.getNodeParameter('uploadKnowledgeBaseId', index, '') as string
			).trim();
			return [
				{
					json: asJson(
						await uploadFile(client, input, {
							wait: waitOptions(context, index),
							knowledgeBaseId: knowledgeBaseId || undefined,
						}),
					),
				},
			];
		}

		case 'audio:transcribe': {
			const input = await binaryInput(context, index);
			const language = context.getNodeParameter('language', index, '') as string;
			return [{ json: asJson(await transcribe(client, input, language)) }];
		}

		default:
			throw new NodeOperationError(
				context.getNode(),
				`Unbekannte Operation ${resource}:${operation}`,
				{ itemIndex: index },
			);
	}
}

async function runChat(
	context: IExecuteFunctions,
	client: OwuiClient,
	models: OwuiModel[],
	index: number,
) {
	const model = String(
		context.getNodeParameter('model', index, undefined, { extractValue: true }) ?? '',
	).trim();
	const inputMode = context.getNodeParameter('inputMode', index, 'prompt') as string;
	const options = context.getNodeParameter('chatOptions', index, {}) as IDataObject;

	const input: ChatInput = {
		model,
		systemPrompt: context.getNodeParameter('systemPrompt', index, '') as string,
		knowledgeBaseIds: splitIds(context.getNodeParameter('knowledgeBaseIds', index, [])),
		fileIds: splitIds(context.getNodeParameter('fileIds', index, '')),
	};
	if (inputMode === 'messages') {
		input.messages = parseMessages(context.getNodeParameter('messages', index));
	} else {
		input.prompt = context.getNodeParameter('prompt', index) as string;
	}
	const temperature = toOptionalNumber(options.temperature, 'Temperatur');
	if (temperature !== undefined) input.temperature = temperature;
	if (options.responseFormat !== undefined) {
		input.responseFormat = parseJsonObject(options.responseFormat, 'Antwortformat');
	}

	const checks: ChatChecks = {
		requireSources: toRequireSources(options.requireSources),
		parseJson: options.parseJson === true,
		checkModel: options.checkModel === true,
		includeRaw: options.includeRaw === true,
		timeoutMs: toSeconds(options.timeout, 'Timeout in Sekunden', 300) * 1000,
	};
	return chatComplete(client, models, input, checks);
}

/** `null` heißt: nicht warten. Ungültige Werte sind Fehler, Defaults gelten nur für fehlende Felder. */
function waitOptions(context: IExecuteFunctions, index: number): WaitOptions | null {
	if (!(context.getNodeParameter('waitForProcessing', index, true) as boolean)) return null;
	const options = context.getNodeParameter('waitOptions', index, {}) as IDataObject;
	return {
		timeoutMs: toSeconds(options.timeout, 'Timeout in Sekunden', 300) * 1000,
		intervalMs: toSeconds(options.interval, 'Abfrageintervall in Sekunden', 2) * 1000,
	};
}

async function binaryInput(context: IExecuteFunctions, index: number): Promise<UploadInput> {
	const property = context.getNodeParameter('binaryPropertyName', index) as string;
	const binary = context.helpers.assertBinaryData(index, property);
	const data = await context.helpers.getBinaryDataBuffer(index, property);
	return toUploadInput(property, data, {
		fileNameOverride: context.getNodeParameter('fileName', index, '') as string,
		fileName: binary.fileName,
		mimeType: binary.mimeType,
	});
}
