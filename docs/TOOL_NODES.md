# Tool-Varianten

Übernommen aus `n8n-nodes-neurawork/docs/TOOL_NODES.md` (dort gemessen an n8n 2.20.11) und für Open WebUI
zugeordnet. Die Node erscheint in n8n dreifach:

| Erscheinung | Registrierter Typ | Wofür | `usableAsTool` |
|---|---|---|---|
| Workflow-Node | `openWebUi` | Mensch baut einen Workflow, alle Operationen | fehlt |
| Lese-Werkzeug | `openWebUiRead` → n8n macht `openWebUiReadTool` | KI-Agent, nur lesend | `{ replacements: { description } }` |
| Schreib-Werkzeug | `openWebUiWrite` → n8n macht `openWebUiWriteTool` | KI-Agent, nur verändernd | `{ replacements: { description } }` |

## Warum zwei Werkzeuge

Ein Agent wählt aus dem, was er sieht. Liegt „Upload“ neben „Search“ im selben Werkzeug, ist Schreiben in jedem
Reasoning-Schritt eine Option. Die Trennung ist eine Rechteschranke, kein Feintuning der Beschreibung — und sie
macht im Canvas sichtbar, ob ein Assistent in Open WebUI schreiben darf.

## Wie n8n Werkzeuge erzeugt

- `createAiTools` filtert nach `Boolean(usableAsTool)` und hängt `Tool` an Namen und Anzeigenamen an. Pro
  registriertem Typ entsteht genau eine Werkzeug-Variante — zwei Varianten brauchen also zwei Typen.
- Community-Pakete sind seit n8n PR #14042 (März 2025) ohne Env-Schalter als Werkzeug nutzbar;
  `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE` liest n8n nicht mehr. Der CI-Job `n8n-load` prüft das für 2.44.4 als
  Matrix: Mit der Env müssen die Varianten entstehen (sonst rot), ohne Env meldet er eine Warnung — das Job-Summary
  zeigt, ob der Rollout die Env braucht.
- Die Workflow-Node trägt **kein** `usableAsTool`. Mit `true` erzeugte n8n zusätzlich `openWebUiTool` mit vollem
  Zugriff; `false` lässt der Typ `INodeTypeDescription` nicht zu. Der Lint `node-usable-as-tool` ist an genau
  dieser Stelle mit Begründung abgeschaltet.

## Regeln

- **R1 — eine Implementierung.** Die Varianten haben keine eigene Logik: `execute = OpenWebUi.prototype.execute`.
- **R2 — disjunkt.** Lese- und Schreibmenge teilen keine Operation. Zuordnung nach Wirkung in Open WebUI, nicht
  nach HTTP-Methode: Chat und Suche sind `POST`, ändern aber nichts.
- **R3 — vollständig, testgesichert.** Jede Operation steht in genau einer Liste. Ein Test vergleicht die
  Vereinigung mit der Basis-Node.
- **R4 — die Beschreibung nennt die Grenze.** Zwei Sätze: Zweck und was das Werkzeug *nicht* kann.
- **R5 — harte Regeln gelten unverändert.** Kein Löschen, `delete_file=false` bei Remove File, Prüfungen vor und
  nach dem Chat.
- **R6 — `methods` in jeder Variante.** `toolVariant()` kopiert nur die Beschreibung. Ohne `methods = owuiMethods`
  bleiben „Aus Liste“ und Dropdowns im Werkzeug leer. Ein Test prüft, dass jede referenzierte
  `searchListMethod`/`loadOptionsMethod` in jeder Variante existiert. (Die gleiche Lücke hat
  `n8n-nodes-neurawork/nodes/shared/toolVariant.ts`; dort separat nachziehen.)

## Zuordnung

| Lesen (`OWUI_READ_OPERATIONS`) | Schreiben (`OWUI_WRITE_OPERATIONS`) |
|---|---|
| Chat: Complete · Model: Get, Get Many · Knowledge: Get, Get Many, Search · File: Get, Get Many, Download · Audio: Transcribe | Knowledge: Create, Add File, Remove File · File: Upload |

## Definition of Done für eine neue Operation

1. In der Basis-Node angelegt, Parameter mit `displayOptions` an Ressource und Operation gebunden.
2. In genau eine der beiden Listen eingetragen (sonst schlägt R3 fehl).
3. Unit-Test für Erfolg und Fehlerfall.
4. Neue Auswahllisten in `owuiMethods` (sonst schlägt R6 fehl).
