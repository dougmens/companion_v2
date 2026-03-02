# AGENTS.md — Companion System (Local UI Governance)

## Authoritative UI Specification Files
Before implementing any UI-related functionality, read:

- docs/ACTIVE/UI_SPEC_V1.md
- docs/ACTIVE/UI_BACKLOG_V1.md
- docs/ACTIVE/UI_DATA_CONTRACT.md
- docs/ACTIVE/UI_RUNBOOK_LOCAL.md

If any conflict exists:
- UI_DATA_CONTRACT.md governs data schema and snapshot structure.
- UI_SPEC_V1.md governs UX and interaction behavior.

## Non-Negotiable Rules

1. Do NOT modify ingest logic or existing CLI behavior.
2. UI must be read-only by default.
3. ALL write operations must occur via intent files in 60_intents/.
4. Intents must be applied using existing `intent:apply-v2`.
5. Never overwrite existing files; use timestamp-based filenames.
6. Handle missing folders/files gracefully (no crashes).
7. All changes must be deterministic and testable.

## Required Validation Before Completion

You must run:

- npm install
- npm test
- npm run ui:export
- npm run ui:sync
- npm run ui:build

If any command fails, fix the issue before completing the task.

## Snapshot Model

UI reads:
ui/public/dashboard_state.json

Snapshot is generated from:
80_export/dashboard_state.json

Refreshing UI data requires:
npm run ui:export
npm run ui:sync

## Philosophy

- File-first.
- Auditable (Events + Reports).
- Deterministic.
- Reproducible.
- Governance over convenience.
