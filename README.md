# n8n-nodes-open-webui

n8n-Baustein für [Open WebUI](https://github.com/open-webui/open-webui): Chat mit Modellen und Presets,
Wissensdatenbanken, Dateien und Audio — per Auswahlliste statt Hand-JSON im HTTP-Node.

Ein umbenanntes oder gelöschtes Modell, eine nicht freigegebene Wissensdatenbank oder ein Preset, das plötzlich
streamt, führen zu einem klaren Fehler statt zu einem Workflow, der still Unsinn liefert oder hängen bleibt.

> Status: `0.1.0`, im Bau. Getestet wird gegen Open WebUI `0.11.4` (Fork `nw.2`) und n8n `2.44.4`.

## Installation

In n8n unter **Einstellungen → Community Nodes → Install** den Paketnamen `n8n-nodes-open-webui` eintragen.
Im Standard-Image `n8nio/n8n` ist das ohne Zusatzeinstellung möglich. Pakete landen unter
`/home/node/.n8n/nodes` — liegt dieser Pfad auf einem Volume, überstehen sie Neustarts und Image-Updates.

Das Paket hat keine Laufzeit-Abhängigkeiten.

## Credential „Open WebUI API“

| Feld | Inhalt |
|---|---|
| Base URL | Wurzel-URL ohne Pfad. Im Kubernetes-Cluster die interne Service-URL (z. B. `http://open-webui.<namespace>.svc.cluster.local:8080`), damit lange RAG-Antworten nicht in den Ingress-Timeout laufen. |
| API Key | API-Key eines Open-WebUI-Nutzers (`sk-…`, Einstellungen → Konto → API-Schlüssel). |

Der Credential-Test ruft `GET /api/v1/knowledge/?page=1` auf. Der Endpunkt prüft wie alle der Node die Rolle des
Nutzers: Ein Key, dessen Nutzer noch „pending“ ist, fällt schon hier durch.

Rechte steuert Open WebUI über den Nutzer hinter dem Key. Empfehlung: ein eigener Dienstnutzer (z. B. `n8n-service`,
Rolle `user`) mit Zugriff nur auf die freigegebenen Wissensdatenbanken und Presets. Voraussetzungen in Open WebUI:

- API-Keys sind eingeschaltet (`ENABLE_API_KEYS`), und der Nutzer hat die Berechtigung „API Keys“.
- Ein Nutzer mit Rolle `user` sieht ein Base-Modell (z. B. `low`, `medium`) nur, wenn es in Open WebUI als Modell
  angelegt und für ihn freigegeben ist. Ein Preset funktioniert nur, wenn auch sein Base-Modell freigegeben ist.
- Ist `API_KEYS_ALLOWED_ENDPOINTS` aktiv, braucht der Baustein `/api/models`, `/api/chat/completions`,
  `/api/v1/knowledge`, `/api/v1/files`, `/api/v1/retrieval` und `/api/v1/audio` (ohne Schrägstrich am Ende — so
  decken die Einträge auch die Unterpfade ab).

## Operationen

| Ressource | Operation | Werkzeug-Variante |
|---|---|---|
| Chat | **Complete** — Modell oder Preset, optional Systemprompt, Prompt oder Messages-JSON, Wissensdatenbanken, Datei-IDs. Optionen: Temperatur, Antwortformat, JSON parsen, Quellen erforderlich, Modell abgleichen (Standard aus), Timeout (Standard 300 s), Rohantwort | Lesen |
| Model | **Get Many** (alle, Base, Presets), **Get** (inkl. Base-Modell und angehängter Wissensdatenbanken) | Lesen |
| Knowledge | **Get Many**, **Get** (mit Dateiliste), **Search** (Textstellen mit Score) | Lesen |
| Knowledge | **Create**, **Add File** (wartet auf die Verarbeitung), **Remove File** (Datei bleibt erhalten) | Schreiben |
| File | **Get**, **Get Many** (Dateinamensmuster), **Download** (Binär) | Lesen |
| File | **Upload** (multipart, wartet auf die Verarbeitung, optional direkt in eine Wissensdatenbank) | Schreiben |
| Audio | **Transcribe** (Binär → Text) | Lesen |

Bewusst nicht enthalten: Löschen von Dateien oder Wissensdatenbanken, Admin-Endpunkte, ein freier „Raw Request“.

Ausgabe von **Chat → Complete**, ein Item pro Eingabe-Item:

```json
{ "content": "…", "json": { }, "model": "medium", "usage": { }, "sources": [{ "name": "a.pdf", "id": "…", "knowledgeBaseId": "…" }], "raw": { } }
```

`json` nur mit „JSON Parsen“, `raw` nur mit „Rohantwort Mitgeben“ (hilft beim Umstieg von Ausdrücken auf
`choices[0].message.content`).

### Auswahllisten

- **Modell**: `Preset · Beratungsauswerter (→ medium)` bzw. `Base · low`. Presets, deren Base-Modell verschwunden
  ist, erscheinen als `⚠ defekt`.
- **Wissensdatenbanken**: alle Seiten, Anzeige `Name (n Dateien)`.
- **Datei**: Teilsuche im Dateinamen. Open WebUI liefert dabei nur **eigene** Dateien des Key-Nutzers; fremde,
  freigegebene Dateien über „ID“ wählen.

### Als Werkzeug für KI-Agenten

Die Workflow-Node „Open WebUI“ ist bewusst **kein** Werkzeug. Für Agenten gibt es zwei eigene Typen:
**Open WebUI (Lesen)** und **Open WebUI (Schreiben)** — n8n macht daraus „… Tool“. Wer nur das Lese-Werkzeug
anhängt, gibt dem Agenten keinen Schreibzugriff. Regeln: [`docs/TOOL_NODES.md`](docs/TOOL_NODES.md).

## Fehlerverhalten

Kein stilles Fallback, kein eigener Retry (dafür gibt es n8ns „Retry on Fail“).

- Jede Nicht-2xx-Antwort wird zu einem `NodeApiError` mit Status, `detail` von Open WebUI, Endpunkt (mit ID) und
  einem Hinweis zur Ursache.
- Vor dem Chat: Das Modell muss in `/api/models` stehen — sonst „Modell `gpt-5.6-luna` existiert nicht oder ist für
  den API-Key nicht sichtbar, verfügbar: low, medium, high“. Bei einem Preset muss auch das Base-Modell sichtbar
  sein. Jede gewählte Wissensdatenbank muss für den Key lesbar sein, jede Datei-ID lesbar und fertig verarbeitet.
- Prüfungen auf die Antwort:
  - Streaming (SSE) statt JSON → Fehler mit Hinweis auf „Stream Chat Response“ im Preset.
  - Nur mit „Modell Abgleichen“ (Standard aus): Modell der Antwort ist weder das angefragte noch dessen Base-Modell,
    auch ohne Präfix der Verbindung → Fehler. Standardmäßig aus, weil Open WebUI den Namen des Anbieters
    durchreicht und Azure/LiteLLM oft Deployment- oder Snapshot-Namen melden.
  - Keine Quellen, obwohl eine Wissensdatenbank oder Datei gewählt ist → Fehler (Option „Quellen Erforderlich“).
  - „JSON Parsen“ und ungültiges JSON → Fehler mit den ersten 500 Zeichen.
- Upload und Add File fragen den Verarbeitungsstatus ab, bis er `completed` ist. Bei `failed` oder Timeout kommt
  ein Fehler mit der Datei-ID; der Timeout zählt die Wanduhr samt Statusabfragen. Ein Upload mit Wissensdatenbank
  verlangt „Auf Verarbeitung Warten“. Eine Datei ganz ohne Verarbeitungsstatus (Upload mit `process=false`,
  Altdatei) ist sofort ein Fehler — außer sie trägt schon extrahierten Inhalt.
- Keine Antwort (Timeout, Netzwerk) → Fehler mit Endpunkt, beim Chat-Timeout mit Hinweis auf die Option.
- Ungültige Optionswerte aus Ausdrücken (Timeout als Unsinn, unbekannte Quellen-Einstellung) sind Fehler; Defaults
  gelten nur für fehlende Felder.
- Mit „Continue On Fail“ liefert jedes fehlerhafte Item `{ error, status, detail, endpoint }` statt abzubrechen.

## Fallstricke in Open WebUI

- **Stream erzwungen:** `stream_response` im Preset (oder in den globalen Modell-Standardparametern) überschreibt
  `stream:false`. Dann kommt SSE statt JSON — die Node meldet das.
- **Stille Lücken bei Quellen:** Eine Wissensdatenbank oder Datei ohne Zugriff überspringt Open WebUI im Chat ohne
  Fehlermeldung; es fehlen nur die Quellen. Deshalb prüft die Node vorher die Sichtbarkeit und nachher die Quellen.
- **Add File zu früh:** Läuft die Verarbeitung noch, antwortet `file/add` mit „The content provided is empty“ und
  setzt die Datei auf `failed`. Die Node wartet deshalb vorher auf `completed`.
- **Upload in eine Wissensdatenbank:** Die Node hängt Dateien explizit per `file/add` an, nicht über
  `metadata.knowledge_id` — dort meldet Open WebUI ein fehlendes Schreibrecht nur im Log.
- **Remove File:** Open WebUI löscht die Datei standardmäßig mit, wenn der Key ihr Eigentümer ist. Die Node sendet
  immer `delete_file=false`.
- **Fehlerstatus:** Fehler des Modell-Anbieters (auch Rate-Limits) reicht Open WebUI als `400` durch; der
  ursprüngliche Status ist verloren.
- **Systemprompt:** Open WebUI setzt den Systemprompt eines Presets vor eine mitgeschickte System-Message, nicht
  stattdessen.
- **`ENABLE_CUSTOM_MODEL_FALLBACK`** muss aus bleiben, sonst lenkt Open WebUI ein Preset ohne Base-Modell still um.

API-Belege mit Quellstellen im Open-WebUI-Code: [`docs/OWUI_API.md`](docs/OWUI_API.md).

## Entwicklung

Gebaut, gelintet und getestet wird **nur in der GitHub-Pipeline**, nicht lokal. Lokal werden Dateien bearbeitet;
das Lockfile entsteht mit `npm install --package-lock-only --ignore-scripts`.

| Job | Inhalt |
|---|---|
| `test` | `n8n-node lint` (Community-Regeln, strict), `n8n-node build`, Jest-Unit-Tests, `npm pack` mit Inhaltsprüfung |
| `n8n-load` | Matrix ohne/mit `N8N_COMMUNITY_PACKAGES_ALLOW_TOOL_USAGE=true`: installiert den Tarball als Community-Paket in `n8nio/n8n:2.44.4` und prüft die registrierten Node-Typen. Mit Env müssen die Tool-Varianten entstehen, ohne Env wird nur gewarnt (Ergebnis im Job-Summary) |
| `n8n-execute` | Führt die echte Node in `n8nio/n8n:2.44.4` aus (`n8n import:credentials`/`import:workflow`/`execute`) gegen einen Open-WebUI-Stub (`test/n8n/`): Download, Upload als multipart, Chat mit 400 und Continue On Fail, Bearer-Key aus der Credential |
| `e2e-owui` | Nur per „Run workflow“ mit `e2e: true`: Open-WebUI-Container plus OpenAI-Stub — Wissensdatenbank anlegen, Upload, Add File, Suche, Chat mit Quellen, Download, Remove File. Braucht die Secrets `ACR_USERNAME`/`ACR_PASSWORD`. |

### Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `credentials/` | Credential `OpenWebUiApi` |
| `nodes/OpenWebUi/` | Node, Tool-Varianten, Auswahllisten (`methods.ts`), n8n-Anbindung (`GenericFunctions.ts`) |
| `nodes/OpenWebUi/transport.ts`, `operations.ts` | n8n-freier Kern: HTTP-Client, Fehlerübersetzung, Fachlogik |
| `nodes/shared/` | `toolVariant()` — baut die Lese- und Schreib-Variante |
| `test/` | Unit-Tests (`nodes/`, `credentials/`), Mocks (`helpers/`), E2E mit OpenAI-Stub (`e2e/`), n8n-Ausführung mit Open-WebUI-Stub (`n8n/`) |
| `scripts/gen-sidecar.mjs` | erzeugt `n8nac-custom-nodes.json` für n8nac aus dem gebauten `dist` |
| `docs/` | Tool-Varianten-Regeln, API-Belege |

### Release

1. Version in `package.json` erhöhen, committen.
2. Tag `v<version>` pushen → Workflow `Publish` ruft erst die volle CI (`ci.yml` per `workflow_call`, inkl. `n8n-load`
   und `n8n-execute`) für den Tag-Commit auf und veröffentlicht nur, wenn sie grün ist — mit npm-Provenance.

Voraussetzungen: Das Repo ist **öffentlich** (npm erzeugt keine Provenance aus privaten Repos), und das Secret
`NPM_TOKEN` ist gesetzt (geführt in Infisical, Projekt `thecluster`). Nach dem ersten Publish kann auf Trusted
Publishing umgestellt und der Token entfernt werden.

## Lizenz

MIT
