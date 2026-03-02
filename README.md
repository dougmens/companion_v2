# Companion (Dual-Domain Architektur)

Dieses Repository nutzt eine strikte Trennung zwischen zwei Domänen.

## Fach-Domain (Case Layer)
Fokus: fachliche Fallarbeit ohne Runtime-Interna.

Enthaltene Aufgaben:
- `case:list`
- `case:add`
- `case:merge`
- dokumentbezogene Sicht auf Fall-Daten

Start:
- `npm run fach -- case:list`
- `npm run case:list`

## Admin-Domain (Runtime Layer)
Fokus: Systembetrieb, Ingest, Indexing, Intents, Events.

Enthaltene Aufgaben:
- `ingest:watch`, `ingest:once`
- `rag:rebuild`
- `intent:apply`, `intent:apply-v2`
- `events:tail`

Start:
- `npm run admin -- ingest:watch`
- `npm run ingest:watch`

## Explizites Switching
CLI-Router akzeptiert nur Domain-Routing:
- `node src/cli.js fach <command>`
- `node src/cli.js admin <command>`

Damit sind Verantwortlichkeiten klar getrennt und Fachmodus blendet Systeminterna aus.

## LaunchAgent (Production Mode)

To enable automatic ingest:

./runtime/launchagent/install.command

To disable:

./runtime/launchagent/uninstall.command
