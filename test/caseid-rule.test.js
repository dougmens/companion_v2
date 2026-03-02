const test = require("node:test");
const assert = require("node:assert/strict");

const { enforceCaseIdRule, normalizeClassification } = require("../src/lib/openai");

test("enforceCaseIdRule never allows invented case_id", () => {
  const allowed = new Set(["Raeumung_Pullach"]);
  assert.equal(enforceCaseIdRule("Raeumung_Pullach", allowed), "Raeumung_Pullach");
  assert.equal(enforceCaseIdRule("NEW_CASE", allowed), "NEW_CASE");
  assert.equal(enforceCaseIdRule("Erfundener_Fall", allowed), null);
});

test("normalizeClassification strips invalid case_id", () => {
  const allowed = new Set(["Raeumung_Pullach"]);
  const c = normalizeClassification(
    {
      domain: "jur",
      date: "2025-01-31",
      case_id: "Erfundener_Fall",
      case_confidence: 0.99,
    },
    allowed,
  );
  assert.equal(c.case_id, null);
  assert.equal(c.domain, "jur");
});

test('normalizeClassification defaults doc_type when model returns "string"', () => {
  const allowed = new Set(["Raeumung_Pullach"]);
  const c = normalizeClassification(
    {
      domain: "allg",
      date: "2025-01-31",
      doc_type: "string",
      amount: null,
      currency: "EUR",
      reasons: ["original"],
    },
    allowed,
  );
  assert.equal(c.doc_type, "Schreiben");
  assert.equal(c.currency, null);
  assert.ok(c.reasons.includes("doc_type invalid -> defaulted"));
});

test('normalizeClassification ensures doc_tags has a fallback "sonstiges"', () => {
  const allowed = new Set(["Raeumung_Pullach"]);
  const c = normalizeClassification(
    {
      domain: "fin",
      date: "2025-01-31",
      doc_tags: [],
    },
    allowed,
  );
  assert.deepEqual(c.doc_tags, ["sonstiges"]);
});

test("normalizeClassification corrects implausible year and emits warning", () => {
  const allowed = new Set(["Raeumung_Pullach"]);
  const c = normalizeClassification(
    {
      domain: "jur",
      date: "2424-12-04",
      doc_tags: ["test"],
    },
    allowed,
  );
  assert.equal(c.date, "0000-00-00");
  assert.ok(Array.isArray(c.date_warnings));
  assert.ok(c.date_warnings.some((w) => String(w).includes("date_year_out_of_range")));
  assert.ok(c.reasons.some((r) => String(r).includes("date_normalization_warning")));
});

test("normalizeClassification keeps plausible year/date unchanged", () => {
  const allowed = new Set(["Raeumung_Pullach"]);
  const c = normalizeClassification(
    {
      domain: "fin",
      date: "2025-12-04",
      doc_tags: ["test"],
    },
    allowed,
  );
  assert.equal(c.date, "2025-12-04");
  assert.deepEqual(c.date_warnings, []);
});
