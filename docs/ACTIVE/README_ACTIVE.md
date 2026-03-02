# Companion – ACTIVE (lokal)

Aktiver Betrieb: lokaler Dokumenten-Ingest + lokaler RAG-Index.  
System-Root: `~/Documents/Companion` (dieser Workspace).

## Quickstart

```bash
npm install
npm test

# einmalig ingest
npm run ingest:once

# watcher (noch NICHT als LaunchAgent eingerichtet)
npm run ingest:watch

# lokalen Dashboard-Snapshot erzeugen
npm run ui:export
npm run ui:sync

# UI dependencies einmalig installieren
npm --prefix ui install

# UI starten (http://127.0.0.1:5173)
npm run ui:dev
```

Browser:
- `http://127.0.0.1:5173`

Sicherheitsnotiz:
- Die UI ist ein lokaler Snapshot-Viewer und liest nur `dashboard_state.json`.
- `OPENAI_API_KEY` bleibt serverseitig und wird nie an den Browser ausgeliefert.

## UI (local)

Die UI visualisiert den Hybrid Runtime Layer aus einem deterministischen Export:

```bash
# 1) Snapshot aus Runtime-Daten schreiben
npm run ui:export

# 2) Snapshot nach ui/public synchronisieren
npm run ui:sync

# 3) UI Build + Tests
npm run ui:build
npm run ui:test

# 4) React UI starten (nutzt Vite wenn lokal installiert, sonst no-network Fallback-Server)
npm run ui:dev
```

Weitere Kommandos:

```bash
# Build der UI
npm run ui:build
npm run ui:test

# Neues Intent-v2 JSON lokal erzeugen (Schreiben in 60_intents/)
npm run ui:intent:new -- --type show_dashboard
npm run ui:intent:new -- --type case_add --case_id "My_Case_1" --title "My title" --aliases "a,b" --tags "x,y"
```

Hinweis:
- Nach `ui:intent:new` und/oder Laufzeitänderungen erneut `ui:export && ui:sync` ausführen und die UI aktualisieren.
- Die UI liest ausschließlich `ui/public/dashboard_state.json`.

## Hybrid Runtime Layer (Intents/Events)

- Intent anwenden (aus UI/Datei):
  - `npm run intent:apply -- 60_intents/intent.json`
- Intent (UI v2) anwenden:
  - `npm run intent:apply-v2 -- 60_intents/intent_v2.json`
- Events tailen:
  - `npm run events:tail -- --n 20`

Reports/Status:
- pro Intent: `70_runtime/reports/<intent_id>.json`
- Summary Log: `90_logs/runtime.log`

Templates zum Copy/Paste:
- `docs/ACTIVE/INTENT_TEMPLATES/`

## ENV

- `OPENAI_API_KEY` muss gesetzt sein (auch `sk-proj` ist ok).

## Workflow

1) PDFs in `00_inbox/` ablegen  
2) `npm run ingest:once` (oder `npm run ingest:watch`) ausführen

## Retry Queue

Der Watcher schreibt retry-fähige Fälle append-only nach:
- `70_runtime/retry_queue.jsonl`
- archivierte/abgeschlossene Einträge: `70_runtime/retry_queue_archive.jsonl`

Queue abarbeiten:

```bash
# Standard: bis zu 50 queued Einträge
npm run ingest:retry

# Nur anzeigen, was bearbeitet würde
npm run ingest:retry -- --dry-run

# Nur alte Einträge (älter als 30 Minuten), inkl. failed+queued
npm run ingest:retry -- --older-than-minutes 30 --status all --max 200
```

Status:
- `queued`: erneut versuchbar
- `resolved`: erfolgreich abgearbeitet
- `failed`: max attempts erreicht
- `dropped_missing_source`: Quelle fehlt dauerhaft, sauber beendet

Prüfen:
- `tail -n 50 70_runtime/retry_queue.jsonl`
- `tail -n 50 70_runtime/retry_queue_archive.jsonl`

## Wo landen Dateien?

- Original-PDFs (geroutet):
  - `10_processed/juristische_faelle/<case_id|UNASSIGNED>/pdf/…`
  - `10_processed/finanzen/<subcategory>/…`
  - `10_processed/allgemein/<subcategory>/…`
  - Review-Fälle: `10_processed/allgemein/REVIEW_REQUIRED/…`
- Markdown (für juristische Fälle fallbezogen, sonst global):
  - jur: `10_processed/juristische_faelle/<case_id|UNASSIGNED>/md/…`
  - fin/allg: `20_markdown/…`
- Metadaten (für juristische Fälle fallbezogen, sonst global):
  - jur: `10_processed/juristische_faelle/<case_id|UNASSIGNED>/meta/…`
  - fin/allg: `30_metadata/…`
- RAG-Index (JSONL + Embeddings):
  - `40_rag_index/<jur|fin|allg>/<case_id|general>.jsonl`
- Logs:
  - `90_logs/YYYY-MM-DD.log`

## Fälle (Case Registry)

Registry: `case_registry.json`

- Liste: `npm run case:list`
- Fall hinzufügen:
  - interaktiv: `npm run case:add`
  - per Flags: `npm run case:add -- --case_id X --title "..." --aliases "a,b" --tags "t1,t2"`
- Fälle mergen:
  - `npm run case:merge -- --from <case_id_A> --to <case_id_B>`

TODO (Go-Live): Watcher als LaunchAgent (damit `ingest:watch` automatisch läuft).

## LaunchAgent (macOS) – ingest:watch

Template/Installer:
- `runtime/launchagent/install.command` (install/enable/start)
- `runtime/launchagent/uninstall.command` (stop/remove)

Logs:
- `90_logs/ingest-watch.log`

Hinweis: Für `OPENAI_API_KEY` in LaunchAgents ist meist `~/.zprofile` (login shell) der richtige Ort, weil der Agent via `zsh -lc ...` startet.

## RAG Rebuild (append vs rebuild)

Rebuild schreibt **neue Builds** nach `40_rag_index/_builds/<ts>/...` und setzt `40_rag_index/CURRENT`.

- Offline/Test (keine OpenAI Calls):
  - `npm run rag:rebuild -- --mock-embeddings`
- Real embeddings:
  - `OPENAI_API_KEY=... npm run rag:rebuild`

## Archiv

Alte Notion/MCP/Phase-3 Dokumente liegen (falls vorhanden) ausschließlich unter `docs/_ARCHIVE/`.
