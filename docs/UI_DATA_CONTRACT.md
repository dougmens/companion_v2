# UI Data Contract — dashboard_state.json (v1)

## Snapshot file locations
- Source of truth (generated): 80_export/dashboard_state.json
- UI input (synced): ui/public/dashboard_state.json

## Top-level schema (informal)
{
  "generated_at": "ISO-8601",
  "setup_state": { ... },

  "cases": [
    {
      "case_id": "string",
      "title": "string",
      "aliases": ["string"],
      "tags": ["string"],
      "stats": {
        "docs_pdf": number,
        "docs_md": number,
        "docs_meta": number,
        "docs_total": number,
        "events": number,
        "reports": number,
        "last_activity_ts": "ISO-8601 | null",
        "urgency": "ok | attention | urgent",
        "urgency_reasons": ["string"]
      },
      "paths": {
        "root": "string | null",
        "pdf_dir": "string | null",
        "md_dir": "string | null",
        "meta_dir": "string | null"
      }
    }
  ],

  "documents": [
    {
      "doc_id": "string",
      "domain": "jur | fin | allg | unknown",
      "case_id": "string | null",
      "kind": "pdf | md | meta | other",
      "filename": "string",
      "path": "string",
      "size_bytes": number | null,
      "mtime": "ISO-8601 | null"
    }
  ],

  "inbox": [
    {
      "filename": "string",
      "path": "string",
      "size_bytes": number | null,
      "mtime": "ISO-8601 | null"
    }
  ],

  "events": [
    { "id": "string", "ts": "ISO-8601 | null", "type": "string", "domain": "string", "entity_id": "string | null", "payload": {}, "source": "string | null" }
  ],

  "reports": [
    { "filename": "string", "intent_id": "string | null", "ts": "ISO-8601 | null", "status": "string | null", "warnings": [], "errors": [], "raw": {} }
  ],

  "intents": [
    { "filename": "string", "id": "string | null", "ts": "ISO-8601 | null", "type": "string | null", "status": "string | null", "raw": {} }
  ],

  "errors": {
    "jsonl_parse_errors": [
      { "file": "string", "line": number, "error": "string" }
    ]
  }
}
