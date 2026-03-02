# companion-doc-ingest

Lokale Dokumenten‑Ingest‑Pipeline (PDF → Klassifikation → Routing → Markdown/Metadaten → Embeddings → JSONL‑Index).

## Setup

1) Abhängigkeiten installieren:

```bash
npm install
```

2) OpenAI Key setzen (für Klassifikation + Embeddings):

```bash
export OPENAI_API_KEY="..."
```

Optional:
```bash
export OPENAI_CLASSIFY_MODEL="gpt-4o-mini"
export OPENAI_EMBED_MODEL="text-embedding-3-small"
```

## Ordner

- `00_inbox/` – Eingang (PDFs)
- `10_processed/` – Ablage nach Routing
  - `juristische_faelle/<case_id>/{pdf,md,meta,evidence}/`
  - `juristische_faelle/UNASSIGNED/{pdf,md,meta,evidence}/`
  - `finanzen/`
  - `allgemein/`
  - `allgemein/REVIEW_REQUIRED/`
- `20_markdown/` – Markdown (für fin/allg + REVIEW_REQUIRED)
- `30_metadata/` – Metadaten JSON (für fin/allg + REVIEW_REQUIRED)
- `40_rag_index/<domain>/{general|<case_id>}.jsonl` – lokaler RAG‑Index
- `90_logs/YYYY-MM-DD.log` – Lauf‑Logs
- `90_logs/case_merge.log` – Case‑Merge Mapping‑Log (JSONL)

## Case Registry

`case_registry.json` enthält die erlaubten `case_id`s. Das Modell darf **niemals** neue `case_id` erfinden; akzeptiert sind nur:

- ein `case_id` aus der Registry
- `"NEW_CASE"`
- `null`

Archivierte Cases (z.B. nach Merge) bleiben in der Registry, werden aber nicht mehr als gültige Ziele für die Klassifikation angeboten.

## CLI

- Einmalig alle PDFs verarbeiten:
  ```bash
  npm run ingest:once
  ```

- Inbox überwachen:
  ```bash
  npm run ingest:watch
  ```

- Cases anzeigen:
  ```bash
  npm run case:list
  ```

- Case hinzufügen:
  ```bash
  npm run case:add --case_id Raeumung_X --title "Räumung X" --aliases "x,raeumung x" --tags "miete,gericht"
  ```
  Ohne Flags fragt das CLI interaktiv nach.

- Cases mergen:
  ```bash
  npm run case:merge -- --from <case_id_A> --to <case_id_B>
  ```

## Pipeline‑Regeln (Kurzfassung)

- PDF Text ist durchsuchbar (kein OCR).
- `REVIEW_REQUIRED` ist **nur** für technische Fehler:
  - PDF‑Parse‑Error
  - extrahierter Text ist leer
  - OpenAI‑Klassifikation schlägt fehl (API/JSON/Timeout/…)
- Aktenzeichen wird lokal per Regex erkannt und dem Modell als Kontext mitgegeben.
- Routing:
  - `domain="jur"`:
    - wenn `case_id` in Registry **und** `case_confidence >= 0.80` → `10_processed/juristische_faelle/<case_id>/{pdf,md,meta,evidence}/`
    - sonst → `10_processed/juristische_faelle/UNASSIGNED/{pdf,md,meta,evidence}/`
  - `domain="fin"` → `10_processed/finanzen/<subcat>/` (siehe unten)
  - `domain="allg"` → `10_processed/allgemein/<subcat>/` (siehe unten)
- Naming:
  - `YYYY-MM-DD <DocType> <Sender> - <KurzTitel>.pdf`
  - ASCII, max. 120 Zeichen (Basename), Whitespace wird reduziert

### Auto‑Case‑Creation (jur)

Wenn `domain="jur"` und (`case_id` ist `null` oder `"NEW_CASE"` oder `case_confidence < 0.80`), wird **nur dann** ein neuer Case erzeugt, wenn mindestens 2 harte Signale vorliegen:

1) `sender` ist gesetzt und nicht `"Unbekannt"`
2) mindestens eins von:
   - lokales Aktenzeichen (`aktenzeichen_detected`)
   - interne Referenz (z.B. `A-12/2024`)
   - Parteien/Unternehmen (Heuristik: `GmbH`, `AG`, `e.V.` oder Muster `X gegen Y` / `X ./. Y`)

Wenn die Signale nicht reichen, bleibt das Dokument `UNASSIGNED` (kein neuer Case).

### Auto‑Kategorien (fin/allg)

- `doc_tags` hat immer mindestens 1 Tag (Fallback: `sonstiges`).
- `fin` Subkategorien: `versicherung`, `rechnung`, `mahnung`, `steuer`, `bank`, `inkasso`, `sonstiges`
- `allg` Subkategorien: `vertrag`, `korrespondenz`, `behoerde`, `identitaet`, `sonstiges`

## Tests

```bash
npm test
```

## Troubleshooting

- `Missing env var: OPENAI_API_KEY`: Key fehlt. Ohne Key kann nicht klassifiziert/embedded werden.
- PDF landet in `REVIEW_REQUIRED`:
  - PDF‑Parse‑Error, oder
  - extrahierter Text ist leer, oder
  - Klassifikation schlug fehl (OpenAI/API/JSON).
