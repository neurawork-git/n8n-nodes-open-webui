# n8n-nodes-open-webui — Claude Code Guidelines

Öffentliches n8n-Community-Paket für Open WebUI. Zweck, Operationen, Fehlerverhalten und Verzeichnisse: README.md.
Ursprungsplan: `aie-stolley/docs/n8n-OWUI-Baustein.md`.

## Harte Regeln

1. **Nichts lokal bauen oder testen.** Kein `tsc`, `jest`, `npm run …`, `npm install` (außer
   `npm install --package-lock-only --ignore-scripts` fürs Lockfile), keine Docker-Builds. Validierung läuft nur
   über GitHub Actions (`.github/workflows/ci.yml`). Erlaubt: Dateien lesen/schreiben, `git`, `gh`, `npm view`.
2. **Kein stilles Fallback.** Fehler werfen, nie raten oder umleiten. HTTP-Fehler → `OwuiError` (Kern) →
   `NodeApiError` (Node). Eigene Prüfungen → `OwuiCheckError` → `NodeOperationError`.
3. **UI-Texte deutsch mit echten Umlauten**, Code und Bezeichner englisch. Ressourcen- und Operationsnamen bleiben
   englisch (n8n-Konvention, Werkzeugnamen); Lint erzwingt englische Pflichttexte bei dynamischen Auswahllisten
   („Names or IDs“, „Choose from the list …“) und „Whether …“ am Anfang von Boolean-Beschreibungen.
4. **gh nur mit Account `NeuraMax`.**
5. **Keine Laufzeit-Abhängigkeiten** (`dependencies` bleibt leer, Lint `no-runtime-dependencies`).

## Architektur

- `nodes/OpenWebUi/transport.ts` und `operations.ts` sind **n8n-frei** (kein Import aus `n8n-workflow`; ein Test
  prüft das per `jest.doMock`). HTTP und `sleep` werden injiziert.
- `GenericFunctions.ts` verbindet den Kern mit n8n (`httpRequestWithAuthentication`, `sleep` aus `n8n-workflow`,
  `returnFullResponse` + `ignoreHttpStatusErrors`, damit der Kern die Fehler übersetzt).
- `OpenWebUi.node.ts` ist nur die Hülle: Parameter einsammeln, Kern aufrufen, Items bauen (`pairedItem`!), Fehler
  übersetzen, `continueOnFail` pro Item.
- Multipart wird von Hand als Buffer gebaut (`buildMultipart`) — das Paket `form-data` ist per Lint verboten.

## Lint (n8n-node, strict)

`eslint.config.mjs` muss exakt der Default von `@n8n/node-cli` bleiben (strict mode prüft das). Der Lint läuft über
**alle** `.ts`-Dateien inklusive `test/`. Daraus folgt:

- Verboten in `.ts`: `setTimeout`/`setInterval`/`process`/`globalThis`/`__dirname`, Importe außer `n8n-workflow`,
  relativen Pfaden, `crypto` und devDependencies (also kein `fs` in Tests).
- In `catch`-Blöcken nur `NodeApiError`/`NodeOperationError` werfen; im Kern deshalb `parseJson()` statt try/catch.
- In `*.node.ts` nur n8n-Fehlerklassen werfen (`node-execute-block-wrong-error-thrown`) — Prüfungen gehören in
  `operations.ts`.
- `any` ist verboten (typescript-eslint recommended).
- Objekt-Literale `{ name: '<klein>', value }` in `nodes/**` hält `node-param-display-name-miscased` für Optionen
  (Title Case verlangt), außer sie sind direkt Aufruf-Argument → Feldnamen aus Konstanten (`MULTIPART_FILE_FIELD`).
- `icon-validation` verlangt bei jeder `implements INodeType`-Klasse ein Objekt-Literal als `description`; die
  Tool-Varianten (`toolVariant(...)`) tragen deshalb ein begründetes `eslint-disable-next-line`.
- Fehler ohne HTTP-Antwort im Kern über `.then(ok, fail)` abfangen, nicht per try/catch (siehe `OwuiClient.send`).
- Skripte mit `fs`/`process` als `.mjs` (z. B. `scripts/gen-sidecar.mjs`), Umgebung für E2E über Jest-Globals in
  `jest.e2e.config.js`.

## Tool-Varianten

Regeln R1–R6 in `docs/TOOL_NODES.md`. Kurz: Workflow-Node ohne `usableAsTool`; `OpenWebUiRead`/`OpenWebUiWrite`
mit disjunkten Operationsmengen, `execute = OpenWebUi.prototype.execute`, **`methods = owuiMethods`** (sonst leere
Auswahllisten im Werkzeug). Neue Operation → in genau eine der beiden Listen eintragen, sonst schlägt der Test fehl.

## Open-WebUI-API

Belege und Eigenheiten (Pfad:Zeile im Fork) in `docs/OWUI_API.md`. Vor jeder Änderung an einem Endpunkt dort
nachsehen.
