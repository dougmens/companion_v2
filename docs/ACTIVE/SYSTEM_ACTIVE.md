# SYSTEM (ACTIVE) – Lokaler Betrieb

## System-Root (aktiv)

`~/Documents/Companion`

Dieses Repo ist die aktive Arbeitsbasis. Keine externen Root-Annahmen (z.B. `/Users/andreasschonlein/companion-system/`).

## Ordnerstruktur (aktiv)

- `00_inbox/` – Eingang: hier PDFs ablegen
- `10_processed/` – geroutete Original-PDFs (nach Domain/Subkategorie; juristische Fälle zusätzlich nach Case)
- `20_markdown/` – erzeugte Markdown-Dateien (für nicht-juristische Routen global)
- `30_metadata/` – erzeugte JSON-Metadaten (für nicht-juristische Routen global)
- `40_rag_index/` – JSONL-Index + Embeddings (pro Domain/Case)
- `50_events/` – append-only Event-Log (JSONL)
- `60_intents/` – eingehende Intents (JSON)
- `70_runtime/` – Runtime-State/Helper-Dateien (lokal)
- `80_export/` – Export/Dashboard-Artefakte (lokal)
- `90_logs/` – Lauf-Logs (`YYYY-MM-DD.log`)
- `src/` – Ingest/CLI-Implementierung
- `test/` – Tests
- `runtime/` – Templates/Installer (z.B. LaunchAgent)

## Zweck (aktiv)

Lokales Dokumenten-System:
- Ingest von PDFs
- Klassifikation + Routing + Naming
- Markdown + Metadaten
- Embeddings + JSONL (lokaler RAG-Index)

Hybrid Runtime Layer (lokal, minimal):
- UI → Intent (Datei) → lokale Anwendung → Event (append-only)
- Reindex-Builds werden versioniert unter `40_rag_index/_builds/` geschrieben

## Event/Intent Schema (minimal)

Event (JSONL, eine Zeile pro Event):
- `{ id, ts, type, domain, entity_id, payload, source }`

Intent v1 (JSON, lokal/legacy CLI):
- `{ id, ts, action, params, source, status }`

Intent v2 (companion-json-v2, UI-freundlich):
- `{ schema, id, ts, type, domain, entity_id, payload, source, status }`

Pragmatik:
- `id`/`ts` können fehlen; die Runtime ergänzt Defaults.
- `status` wird aktuell nicht in-place zurückgeschrieben (Intent-Datei bleibt unverändert); der Zustand wird über Events sichtbar.

## Runtime Reports (deterministisch, pro Intent)

Bei `intent:apply` und `intent:apply-v2` wird geschrieben:
- Report: `70_runtime/reports/<intent_id>.json`
  - `{ intent_id, ts, status, applied_actions, events_written, registry_changes, warnings, errors }`
- Summary Log (JSONL): `90_logs/runtime.log`

## Canonical Sources (für RAG Rebuild)

Dualität bleibt bestehen (keine Vereinheitlichung in dieser Phase):
- jur: `10_processed/juristische_faelle/<case>/md|meta/…`
- fin/allg: `20_markdown/…` + `30_metadata/…`

Für `rag:rebuild` gilt: **Metadaten-JSON** sind kanonisch (weil sie `source_md`/`source_pdf` enthalten):
- jur: `10_processed/juristische_faelle/**/meta/*.json`
- fin/allg: `30_metadata/*.json`

## Testmodus & Go-Live Reset

Aktuell wird im **Testmodus** gearbeitet:
- Es kann „Datenmüll“ entstehen (PDFs/MD/Meta/Index/Logs).
- Vor Go-Live ist ein **Daten-Reset** geplant und erforderlich.

Reset-Anleitung: `docs/ACTIVE/RESET_PLAYBOOK.md`

## Archiv-Hinweis

Notion/MCP/Phase-3 Konzepte sind **nicht aktiv** und gehören ausschließlich ins Archiv: `docs/_ARCHIVE/`
