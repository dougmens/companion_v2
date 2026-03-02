# STATUS – Lokales Setup (Companion)

Stand: 2026-02-24T20:14:30Z  
Mode: TEST  
Watcher: SET (LaunchAgent Template vorhanden; Installation optional)  
Reset geplant vor Go-Live: YES  
Aktives System: lokales Dokumenten-Ingest + lokaler RAG-Index

Wichtige aktive Dokumente (werden unter `docs/ACTIVE/` geführt):
- `docs/ACTIVE/README_ACTIVE.md`
- `docs/ACTIVE/SYSTEM_ACTIVE.md`
- `docs/ACTIVE/RESET_PLAYBOOK.md`
- `docs/ACTIVE/SETUP_STATE.json`

## Schritt A – Ist-Zustand (Root-Übersicht)

Root-Listing (`ls -la`):

```text
total 96
drwxr-xr-x    17 andreasschonlein  staff    544 Feb 24 20:32 .
drwxr-xr-x@ 1504 andreasschonlein  staff  48128 Feb 24 20:32 ..
-rw-r--r--@    1 andreasschonlein  staff   8196 Feb 24 20:34 .DS_Store
-rw-r--r--     1 andreasschonlein  staff     95 Feb 24 18:37 .gitignore
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 19:17 00_inbox
drwxr-xr-x     6 andreasschonlein  staff    192 Feb 24 19:17 10_processed
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 18:57 20_markdown
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 18:57 30_metadata
drwxr-xr-x     6 andreasschonlein  staff    192 Feb 24 19:17 40_rag_index
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 19:18 90_logs
-rw-r--r--     1 andreasschonlein  staff   3883 Feb 24 20:32 README.md
-rw-r--r--     1 andreasschonlein  staff    651 Feb 24 18:38 case_registry.json
drwxr-xr-x    43 andreasschonlein  staff   1376 Feb 24 18:57 node_modules
-rw-r--r--     1 andreasschonlein  staff  16956 Feb 24 18:51 package-lock.json
-rw-r--r--     1 andreasschonlein  staff    500 Feb 24 20:30 package.json
drwxr-xr-x     5 andreasschonlein  staff    160 Feb 24 20:31 src
drwxr-xr-x     8 andreasschonlein  staff    256 Feb 24 20:32 test
```

Kurzfazit:
- Der Workspace enthält bereits die aktive lokale Ordnerstruktur (`00_inbox` … `90_logs`) plus `src/` und `test/`.
- Eine bestehende `README.md` ist vorhanden und wird in Schritt E auf die neue ACTIVE-Doku umgestellt (vorher archiviert, nichts geht verloren).

## Schritt B – Archivstruktur angelegt

Zeitpunkt: 2026-02-24T20:14:56Z

Angelegt:
- `docs/ACTIVE/`
- `docs/_ARCHIVE/phase3_notion_experiment/`
- `docs/_ARCHIVE/legacy_root_concept/`
- `docs/_ARCHIVE/legacy_misc/`

## Schritt C – Legacy/Phase-3 Artefakte archivieren

Zeitpunkt: 2026-02-24T20:15:45Z

Ergebnis (Workspace-Scan nach Dateinamen/Keywords `notion|mcp|phase3|phase_3` sowie Content-Scan nach `/Users/andreasschonlein/companion-system` und `Atlas-Bridge`):
- Keine passenden Legacy-Dokumente im Workspace gefunden, die verschoben werden könnten.
- Kein “Review needed” offen (falls später Legacy-Dokus dazukommen: in die passenden Ordner unter `docs/_ARCHIVE/` einsortieren).

## Schritt D – ACTIVE-Dokumentation erstellt (lokaler Betrieb)

Zeitpunkt: 2026-02-24T20:17:29Z

Erstellt (verbindlich für dieses lokale Setup):
- `docs/ACTIVE/SYSTEM_ACTIVE.md`
- `docs/ACTIVE/README_ACTIVE.md`
- `docs/ACTIVE/RESET_PLAYBOOK.md`
- `docs/ACTIVE/SETUP_STATE.json` (inkl. `last_successful_ingest`)

## Schritt E – Root-README auf ACTIVE umgestellt

Zeitpunkt: 2026-02-24T20:18:16Z

Änderungen (ohne Verlust, alles archiviert statt gelöscht):
- Vorherige Root-`README.md` archiviert nach `docs/_ARCHIVE/legacy_misc/README_ROOT_PRE_ACTIVE_20260224T201801Z.md`
- Neue Root-`README.md` zeigt ausschließlich auf `docs/ACTIVE/…`

## Schritt F – Abschlussprüfung

Zeitpunkt: 2026-02-24T20:18:43Z

Tests:
- `npm test`: PASS (21/21)

Root-Listing (`ls -la`):

```text
total 96
drwxr-xr-x    18 andreasschonlein  staff    576 Feb 24 21:18 .
drwxr-xr-x@ 1504 andreasschonlein  staff  48128 Feb 24 21:18 ..
-rw-r--r--@    1 andreasschonlein  staff   8196 Feb 24 20:34 .DS_Store
-rw-r--r--     1 andreasschonlein  staff     95 Feb 24 18:37 .gitignore
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 19:17 00_inbox
drwxr-xr-x     6 andreasschonlein  staff    192 Feb 24 19:17 10_processed
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 18:57 20_markdown
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 18:57 30_metadata
drwxr-xr-x     6 andreasschonlein  staff    192 Feb 24 19:17 40_rag_index
drwxr-xr-x     3 andreasschonlein  staff     96 Feb 24 19:18 90_logs
-rw-r--r--     1 andreasschonlein  staff    226 Feb 24 21:18 README.md
-rw-r--r--     1 andreasschonlein  staff    651 Feb 24 18:38 case_registry.json
drwxr-xr-x     5 andreasschonlein  staff    160 Feb 24 21:18 docs
drwxr-xr-x    43 andreasschonlein  staff   1376 Feb 24 18:57 node_modules
-rw-r--r--     1 andreasschonlein  staff  16956 Feb 24 18:51 package-lock.json
-rw-r--r--     1 andreasschonlein  staff    500 Feb 24 20:30 package.json
drwxr-xr-x     5 andreasschonlein  staff    160 Feb 24 20:31 src
drwxr-xr-x     8 andreasschonlein  staff    256 Feb 24 20:32 test
```

`docs/ACTIVE` (`ls -la docs/ACTIVE`):

```text
total 32
drwxr-xr-x  6 andreasschonlein  staff   192 Feb 24 21:17 .
drwxr-xr-x  5 andreasschonlein  staff   160 Feb 24 21:18 ..
-rw-r--r--  1 andreasschonlein  staff  1758 Feb 24 21:17 README_ACTIVE.md
-rw-r--r--  1 andreasschonlein  staff   676 Feb 24 21:17 RESET_PLAYBOOK.md
-rw-r--r--  1 andreasschonlein  staff   340 Feb 24 21:17 SETUP_STATE.json
-rw-r--r--  1 andreasschonlein  staff  1282 Feb 24 21:17 SYSTEM_ACTIVE.md
```

`docs/_ARCHIVE` (`ls -la docs/_ARCHIVE`):

```text
total 0
drwxr-xr-x  5 andreasschonlein  staff  160 Feb 24 21:18 .
drwxr-xr-x  5 andreasschonlein  staff  160 Feb 24 21:18 ..
drwxr-xr-x  3 andreasschonlein  staff   96 Feb 24 21:18 legacy_misc
drwxr-xr-x  2 andreasschonlein  staff   64 Feb 24 21:14 legacy_root_concept
drwxr-xr-x  2 andreasschonlein  staff   64 Feb 24 21:14 phase3_notion_experiment
```

### Abschluss – Ergebnis

Archiviert (ohne Löschung):
- `docs/_ARCHIVE/legacy_misc/README_ROOT_PRE_ACTIVE_20260224T201801Z.md`

Aktiv (lokale Dokumentationsbasis):
- `docs/ACTIVE/SYSTEM_ACTIVE.md`
- `docs/ACTIVE/README_ACTIVE.md`
- `docs/ACTIVE/RESET_PLAYBOOK.md`
- `docs/ACTIVE/SETUP_STATE.json`

Nächster fehlender Schritt (TODO):
- Watcher als LaunchAgent einrichten (damit `npm run ingest:watch` dauerhaft/automatisch läuft).

## Runtime Layer – Hybrid UI (Intents/Events)

Zeitpunkt: 2026-02-24T20:55:22Z

Neu (lokal, minimal):
- Event-Channel: `50_events/` (append-only JSONL)
- Intent-Channel: `60_intents/` (JSON)
- Runtime-State: `70_runtime/`
- Export: `80_export/`
- LaunchAgent Templates: `runtime/launchagent/` (inkl. `install.command`)

CLI:
- `npm run intent:apply -- 60_intents/intent.json`
- `npm run events:tail -- --n 20`
- `npm run rag:rebuild -- --mock-embeddings` (offline/test)
