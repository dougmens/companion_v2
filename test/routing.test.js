const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { decideRouting } = require("../src/lib/routing");

test("routing: jur case with confidence >= 0.80 goes to case folders", () => {
  const registryIds = new Set(["Raeumung_Pullach"]);
  const res = decideRouting(
    { domain: "jur", case_id: "Raeumung_Pullach", case_confidence: 0.8 },
    registryIds,
  );
  assert.equal(res.route, "jur_case");
  assert.ok(res.pdfDir.includes("Raeumung_Pullach"));
});

test("routing: jur case with legal-area prefix uses hierarchical path", () => {
  const caseId = "Strafrecht_Strafanzeigen_Schoenlein";
  const registryIds = new Set([caseId]);
  const res = decideRouting(
    { domain: "jur", case_id: caseId, case_confidence: 0.85 },
    registryIds,
  );
  assert.equal(res.route, "jur_case");
  assert.ok(res.pdfDir.includes(path.join("juristische_faelle", "strafrecht", caseId)));
});

test("routing: jur low confidence goes to UNASSIGNED", () => {
  const registryIds = new Set(["Raeumung_Pullach"]);
  const res = decideRouting(
    { domain: "jur", case_id: "Raeumung_Pullach", case_confidence: 0.79 },
    registryIds,
  );
  assert.equal(res.route, "jur_unassigned");
  assert.ok(res.pdfDir.includes("UNASSIGNED"));
});

test("routing: fin -> finanzen; allg -> allgemein", () => {
  const registryIds = new Set();
  assert.equal(decideRouting({ domain: "fin" }, registryIds).route, "finanzen");
  assert.equal(decideRouting({ domain: "allg" }, registryIds).route, "allgemein");
  assert.ok(decideRouting({ domain: "fin" }, registryIds).pdfDir.includes("sonstiges"));
  assert.ok(decideRouting({ domain: "allg" }, registryIds).pdfDir.includes("sonstiges"));
});

test("routing: fin subcategory picked from tags/doc_type", () => {
  const registryIds = new Set();
  const res = decideRouting({ domain: "fin", doc_tags: ["Versicherung"] }, registryIds);
  assert.equal(res.route, "finanzen");
  assert.equal(res.subcategory, "versicherung");
  assert.ok(res.pdfDir.includes(path.join("finanzen", "versicherung")));
});

test("routing: allg subcategory picked from tags/doc_type", () => {
  const registryIds = new Set();
  const res = decideRouting({ domain: "allg", doc_tags: ["Vertrag"] }, registryIds);
  assert.equal(res.route, "allgemein");
  assert.equal(res.subcategory, "vertrag");
  assert.ok(res.pdfDir.includes(path.join("allgemein", "vertrag")));
});

test("routing: allg -> behoerde subcategory", () => {
  const registryIds = new Set();
  const res = decideRouting({ domain: "allg", doc_tags: ["Behörde"] }, registryIds);
  assert.equal(res.route, "allgemein");
  assert.equal(res.subcategory, "behoerde");
  assert.ok(res.pdfDir.includes(path.join("allgemein", "behoerde")));
});
