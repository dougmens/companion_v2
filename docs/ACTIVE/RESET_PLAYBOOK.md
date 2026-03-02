# RESET_PLAYBOOK (ACTIVE)

Ziel: **Clean Reset nur der Daten** (PDF/MD/Meta/Index/Logs), ohne Code/Docs zu löschen.  
Wichtig: Reset wird **nicht jetzt** ausgeführt, sondern **vor Go-Live**.

## Soft Reset (nur Daten)

1) Watcher stoppen (falls aktiv): `CTRL+C` in `npm run ingest:watch`
2) Inhalte leeren:
   - `00_inbox/`
   - `10_processed/`
   - `20_markdown/`
   - `30_metadata/`
   - `40_rag_index/`
   - `50_events/`
   - `60_intents/`
   - `70_runtime/`
   - `80_export/`
   - `90_logs/`

Hinweis: Die genaue Lösch-/Leeren-Methode ist absichtlich nicht als „one-liner“ fest verdrahtet (Sicherheits-Check vor Go-Live).

## Reindex Builds separat

Wenn `rag:rebuild` genutzt wurde, liegen Builds unter:
- `40_rag_index/_builds/`
- Pointer: `40_rag_index/CURRENT`

Beim Reset sollten `_builds/` und `CURRENT` konsistent mitgeleert werden (ohne die alten Index-Dateien zu verändern, solange keine Migration entschieden wurde).

## Hard Reset (optional)

Zusätzlich zum Soft Reset:
- Registry zurücksetzen (nach Backup): `case_registry.json`
