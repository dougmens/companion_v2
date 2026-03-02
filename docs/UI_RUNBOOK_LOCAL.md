# UI Runbook (Local)

## Commands (from repo root)
1) Generate snapshot:
   npm run ui:export

2) Sync snapshot into UI:
   npm run ui:sync

3) Run UI dev server:
   npm run ui:dev

4) Build UI:
   npm run ui:build

5) Create intent files:
   npm run ui:intent:new -- --type case_add --case_id X --title "..." --aliases "a,b" --tags "t1,t2"
   npm run ui:intent:new -- --type case_update --case_id X --title "..." --aliases "a,b" --tags "t1,t2"
   npm run ui:intent:new -- --type show_dashboard

6) Apply intent (existing pipeline):
   npm run intent:apply-v2 -- 60_intents/<file>.json

7) Refresh UI data:
   npm run ui:export
   npm run ui:sync

## Troubleshooting
- UI shows "no snapshot":
  Run ui:export + ui:sync, then reload.
- Health badge red:
  Check latest report in 70_runtime/reports and runtime log in 90_logs/runtime.log.

## MVP Philosophy
- UI does not mutate data directly.
- All writes are intents + apply + reports/events.
