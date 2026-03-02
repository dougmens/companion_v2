# UI Spec v1 — Companion (Local)

## Purpose
Build a local, file-first UI that makes the daily workflow fast and auditable:
Inbox → Assign/Organize → Understand → Act (via intents) → Verify (events/reports).

## Principles
- Scope-first UI: Always show current scope (global/domain/case) and what data it uses.
- Read-only by default. Writes happen through intent files + existing apply pipeline.
- Every derived result should be explainable (why/where/from which file).
- Never crash on missing files; show empty states.
- Diagnostics exist but do not dominate the main UX.

## Information Architecture (Left Nav)
1. Fälle
2. Dokumente
3. Inbox
4. Chat
5. Events (Diagnostics)

## Global Shell
Top Bar:
- App title
- Snapshot timestamp (from dashboard_state.generated_at)
- Health badge (derived from setup_state + latest reports)
- Global search input (filters current page)

Right Drawer:
- Used for Case edit, Doc details, etc.
Modals:
- Used for Wizards / irreversible actions (case merge later, export, reset warning)

## Pages

### Fälle
Views:
- Cards (default)
- Table
- Similarity (toggle: similarity to selected case)

Case Card fields:
- title, case_id
- tags (chips)
- counts: docs_total, docs_pdf, docs_md, docs_meta
- last_activity_ts
- urgency badge (ok/attention/urgent)
Actions:
- Open (go to case detail)
- Edit (opens right drawer)

Case Detail:
- Tabs: Timeline | Docs | Notes (notes may be MVP placeholder)
Timeline:
- show events + reports related to case_id
Docs:
- list + preview launcher (to Dokumente preview pane)

Similarity:
- show % and "why" (shared tags)
- sort by similarity desc

### Dokumente
Layout: 3-pane explorer
- Left: virtual tree (from snapshot documents[] + paths)
- Middle: file list (sortable: name/date/size/type)
- Right: preview panel (PDF embed, MD, JSON pretty)
Always show:
- Path chip (physical path)
- Copy path button

### Inbox
Show inbox queue from snapshot.inbox[]
- Basic file info + suggested actions (MVP: show "create case intent" command)
Future: Assign to case via new intent type (not in MVP).

### Chat
MVP: UI-only panel that shows:
- Scope banner (case_id/domain, doc count)
- Message list (local state)
- Quick buttons (summary/legal points/formulation)
No model integration required in v1.

### Events (Diagnostics)
Two tabs:
- Events timeline (filters: type/domain/entity_id)
- Reports list (status/warnings/errors + expandable JSON)

## UX Details
- Empty states everywhere
- Filters: Reset filters button
- Multi-select optional in v1; can be added later
