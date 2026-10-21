# Open-WebUI-API — was der Baustein nutzt

Stand: Fork `v0.11.4-nw.2-3-g224e9a071`. Pfade relativ zu `backend/open_webui/`. Erhoben am 21.10.2026 durch
Lesen des Codes, nicht live gemessen — Stellen mit **unsicher** prüft der E2E-Job bzw. der erste Live-Einsatz.

## Querschnitt

- **Auth:** `Authorization: Bearer sk-…`. Keys mit `sk-` gelten als API-Key (`utils/auth.py:419-436`). API-Keys
  aus → 403 „Use of API key is not enabled…“; für Nicht-Admins zusätzlich Berechtigung `features.api_keys`
  (`utils/auth.py:526-537`). Unbekannter Key → 401; ohne Token → 401 „Not authenticated“.
- **`API_KEYS_ALLOWED_ENDPOINTS`** greift nur mit `auth.api_key.endpoint_restrictions`. Erlaubt ist
  `path == allowed` oder `path.startsWith(allowed + '/')` (`utils/auth.py:541-551`) — Einträge ohne Schrägstrich am
  Ende decken die Unterpfade ab.
- **Fehlerformat:** `{"detail": "<text>"}`; bei Schemafehlern (422) ist `detail` ein Array aus `{loc, msg, type}`.
- **Version:** `GET /api/version` ohne Auth → `{"version":"0.11.4-neurawork"}` (Fork-Tag `nw.2` steht dort nicht).

## Endpunkte

| Zweck | Endpunkt | Eigenheiten |
|---|---|---|
| Credential-Test | `GET /api/v1/knowledge/?page=1` | Hinter `get_verified_user` wie alle Endpunkte der Node (`routers/knowledge.py:192`, `utils/auth.py:570-575`): Rolle „pending“ → 401. `GET /api/v1/auths/` hängt nur an `get_current_user` (`routers/auths.py:255-259`) und wäre bei „pending“ grün; außerdem enthält seine Antwort den Key im Klartext. |
| Modelle | `GET /api/models` → `{data:[…]}` | Rolle `user` sieht Base-Modelle nur mit DB-Eintrag und Freigabe (`utils/models.py:561-571`). Preset: `preset: true`, `info.base_model_id`; `info.params` ist entfernt (Systemprompt und `stream_response` unsichtbar). Preset mit fehlendem Base-Modell bleibt in der Liste (`utils/models.py:214-225`). |
| Chat | `POST /api/chat/completions` | Ohne `chat_id`/`session_id`/`id` synchron (`main.py:1899-1902`), sonst `task_ids`. `files: [{type:"collection",id}, {type:"file",id}]`. Ohne Zugriff wird ein Item **still übersprungen** (`retrieval/utils.py:2124-2173`). `sources` als Top-Level-Feld (`middleware.py:4543-4545`). `stream_response` aus Preset/Defaults überschreibt `stream` (`main.py:1216-1217`). Unbekanntes Modell (nicht in `MODELS`) → 400 „Model not found“ (`main.py:1152`); fehlende Freigabe für Modell oder Base-Modell eines Presets → **403** „Model not found“ (`utils/access_control/__init__.py:451-459`, `main.py:1181`). Provider-Fehler (auch 429) → 400. `model` der Antwort reicht OWUI vom Anbieter unverändert durch (`routers/openai.py:1849`); der `prefix_id` der Verbindung ist dabei abgeschnitten (`routers/openai.py:1557`, `utils/model_ids.py`). Ob LiteLLM Alias oder Deployment-Name meldet: **unsicher** — deshalb ist „Modell Abgleichen“ standardmäßig aus. |
| Wissensdatenbanken | `GET /api/v1/knowledge/?page=N` | 30 pro Seite, `{items, total}`; DB-Fehler liefert still `{items:[], total:0}`. |
| | `GET /api/v1/knowledge/{id}` | `files` ist `null`; kein Zugriff → **401** (nicht 403), fehlt → 404. |
| | `GET /api/v1/knowledge/{id}/files?page=N` | Dateiliste, 30 pro Seite. |
| | `POST /api/v1/knowledge/create` | Body `{name, description}`; ohne Berechtigung `workspace.knowledge` → 401. |
| | `POST /api/v1/knowledge/{id}/file/add` | Body `{file_id}`. Datei noch in Verarbeitung → „400: The content provided is empty“ **und Datei wird `failed`**. `FILE_NOT_PROCESSED` nur nach Upload mit `process=false`. |
| | `POST /api/v1/knowledge/{id}/file/remove?delete_file=` | Default von `delete_file` löscht die Datei mit, wenn der Aufrufer Eigentümer ist. |
| Suche | `POST /api/v1/retrieval/query/collection` | `{collection_names, query, k}`; `k=0` wird ignoriert. Antwort `{documents:[[…]], distances:[[…]], metadatas:[[…]]}`, Score absteigend. Ein nicht erlaubter Name → 403. |
| Upload | `POST /api/v1/files/` (multipart `file`) | Verarbeitung im Hintergrund, Antwort `data.status: "pending"`. `metadata.knowledge_id` verknüpft automatisch, meldet fehlendes Schreibrecht aber nur im Log. Zu groß → 413. |
| Status | `GET /api/v1/files/{id}/process/status` | Nur `{status}` (`pending`, `processing`, `completed`, `failed`); Fehlertext über `GET /api/v1/files/{id}` → `data.error`. Kein Zugriff → 404. Fehlt `data.status` (Upload mit `process=false`, Altdatei), meldet er trotzdem `pending` (`routers/files.py:694`) — die Node klärt jedes erste `pending` unklarer Herkunft über `GET /api/v1/files/{id}` (`data.content` vorhanden → verarbeitet). |
| Datei | `GET /api/v1/files/{id}`, `GET /api/v1/files/{id}/content` | `data.content` ist der extrahierte Volltext (groß). Content liefert die Originaldatei mit `meta.content_type`. |
| Dateisuche | `GET /api/v1/files/search?filename=&content=&limit=` | `filename` ist ein Glob (`*`, `?`), nur eigene Dateien. **Leeres Ergebnis → 404** „No files found matching the pattern.“ |
| Audio | `POST /api/v1/audio/transcriptions` (multipart `file`, `language`) | MIME-Type des Parts muss passen (Default `audio/*`, `video/webm`), sonst 400. Berechtigung `chat.stt`. Antwort `{text, filename}`. |
