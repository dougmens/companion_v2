# UI Backlog v1 (MVP → Phase 2)

## MVP (must-have)

### UI-01 App Shell
- Left nav, top bar, routing.
Acceptance:
- Snapshot time + health badge visible.

### UI-02 Snapshot Loader + Empty States
- Load ui/public/dashboard_state.json, robust fallbacks.
Acceptance:
- Missing snapshot shows instructions, no crash.

### UI-03 Fälle: Cards View + Filters
- Cards default, tag chips, domain chips, search, sort.
Acceptance:
- Card shows title/tags/counts/urgency/last_activity.

### UI-04 Case Edit Drawer (Intent-based)
- Edit title/aliases/tags in drawer.
- Save => show CLI command or create intent file via helper script.
Acceptance:
- No direct registry write in browser.

### UI-05 Case Detail (Timeline + Docs)
- Timeline shows events + reports for case_id.
- Docs list launches preview.
Acceptance:
- Filters for timeline work.

### UI-06 Dokumente: Explorer + Preview
- Virtual tree + file list + preview.
Acceptance:
- Copy path works; preview renders PDF/MD/JSON.

### UI-07 Inbox: Queue
- Show inbox files + quick actions (case add intent).
Acceptance:
- Basic list renders from snapshot.inbox[].

### UI-08 Events: Timeline + Reports
- Diagnostics views.
Acceptance:
- Reports show status/warnings/errors.

### UI-09 Exporter + Scripts
- ui:export, ui:sync, ui:dev, ui:build, ui:test, ui:intent:new.
Acceptance:
- All commands run.

## Phase 2 (high value)
### UI-10 Similarity View (tag Jaccard)
### UI-11 Tag Network Overlay
### UI-12 Saved Views
### UI-13 Assign Doc → Case (new intent type)
### UI-14 Evidence/Excerpt as Events (optional new intent type)

## Phase 3 (nice)
### UI-15 Draft Editor + Insert from Chat + Export PDF/DOCX
