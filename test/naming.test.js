const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPdfBaseName,
  buildPdfFilename,
  normalizeDateWithPlausibility,
} = require("../src/lib/naming");

test("buildPdfFilename uses defaults and .pdf extension", () => {
  const fn = buildPdfFilename({
    date: null,
    doc_type: null,
    sender: null,
    title_suggestion: null,
  });
  assert.ok(fn.endsWith(".pdf"));
  assert.ok(/^\d{4}-00-00 /.test(fn), `unexpected date placeholder: ${fn}`);
  assert.ok(fn.includes("Schreiben"));
  assert.ok(fn.includes("Unbekannt"));
  assert.ok(fn.includes(" - Dokument"));
});

test("buildPdfBaseName is sanitized and max 120 chars", () => {
  const base = buildPdfBaseName({
    date: "2025-01-31",
    doc_type: "Mahnung",
    sender: "ACME GmbH",
    title_suggestion: "Rechnung 123/2025: Überfällig!!!",
  });

  assert.ok(base.length <= 120, `base too long: ${base.length}`);
  assert.match(base, /^[A-Za-z0-9 ._-]+$/);
  assert.ok(base.startsWith("2025-01-31 "));
  assert.ok(base.includes(" - "));
});

test("sender normalization replaces newlines/tabs and collapses spaces", () => {
  const base = buildPdfBaseName({
    date: "2025-01-31",
    doc_type: "Schreiben",
    sender: "ACME\n\nGmbH\t\t   Berlin",
    title_suggestion: "Titel",
  });
  assert.ok(base.includes("ACME GmbH Berlin"), base);
  assert.ok(!/\s{2,}/.test(base), `has multiple spaces: "${base}"`);
});

test("segment caps shorten long doc_type/sender/title", () => {
  const longA = "A".repeat(200);
  const baseA = buildPdfBaseName({
    date: "2025-01-31",
    doc_type: longA,
    sender: "S",
    title_suggestion: "T",
  });
  const docTypeSeg = baseA.slice("2025-01-31 ".length).split(" ")[0];
  assert.equal(docTypeSeg.length, 30);

  const longB = "B".repeat(200);
  const baseB = buildPdfBaseName({
    date: "2025-01-31",
    doc_type: "DT",
    sender: longB,
    title_suggestion: "T",
  });
  const afterDate = baseB.slice("2025-01-31 ".length);
  const senderSeg = afterDate.split(" - ")[0].split(" ").slice(1).join(" ");
  assert.equal(senderSeg.length, 40);

  const longC = "C".repeat(200);
  const baseC = buildPdfBaseName({
    date: "2025-01-31",
    doc_type: "DT",
    sender: "S",
    title_suggestion: longC,
  });
  const titleSeg = baseC.split(" - ")[1];
  assert.equal(titleSeg.length, 50);
});

test("fallbacks: empty fields -> Schreiben/Unbekannt/Dokument", () => {
  const base = buildPdfBaseName({
    date: "2025-01-31",
    doc_type: "   \n\t ",
    sender: "",
    title_suggestion: "   ",
  });
  assert.ok(base.includes(" Schreiben "));
  assert.ok(base.includes(" Unbekannt - Dokument"));
});

test('optional: domain fin + doc_type "Schreiben" -> Finanzdokument', () => {
  const base = buildPdfBaseName({
    date: "2025-01-31",
    domain: "fin",
    doc_type: "Schreiben",
    sender: "Bank",
    title_suggestion: "Auszug",
  });
  assert.ok(base.includes(" Finanzdokument Bank - Auszug"), base);
});

test("normalizeDateWithPlausibility: month/year and year-only are normalized", () => {
  const ym = normalizeDateWithPlausibility("2025-09");
  assert.equal(ym.date, "2025-09-00");
  assert.deepEqual(ym.warnings, []);

  const y = normalizeDateWithPlausibility("2024");
  assert.equal(y.date, "2024-00-00");
  assert.deepEqual(y.warnings, []);
});
