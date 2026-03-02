const test = require("node:test");
const assert = require("node:assert/strict");

const { validateSemanticJurCaseAssignment } = require("../src/lib/semantic_case");

test("semantic filter: Strafanzeige darf nicht Unterhalt_Schoenlein bleiben", () => {
  const registryIds = new Set([
    "Unterhalt_Schoenlein",
    "Strafrecht_Strafanzeigen_Schoenlein",
  ]);

  const classification = {
    domain: "jur",
    case_id: "Unterhalt_Schoenlein",
    case_confidence: 0.91,
    title_suggestion: "Strafanzeige gegen Andreas Schönlein",
    doc_type: "Schreiben",
    doc_tags: ["sonstiges"],
  };

  const res = validateSemanticJurCaseAssignment(classification, registryIds);
  assert.equal(res.changed, true);
  assert.equal(res.classification.case_id, "Strafrecht_Strafanzeigen_Schoenlein");
  assert.ok(res.classification.case_confidence >= 0.85);
});

test("semantic filter: Bußgeld darf nicht Unterhalt_Schoenlein bleiben", () => {
  const registryIds = new Set([
    "Unterhalt_Schoenlein",
    "Verwaltungsrecht_Bussgeld_Pflegeversicherung",
  ]);

  const classification = {
    domain: "jur",
    case_id: "Unterhalt_Schoenlein",
    case_confidence: 0.9,
    title_suggestion: "Bußgeldbescheid wegen Pflegeversicherungspflicht",
    doc_type: "Bußgeldbescheid",
    doc_tags: ["verwaltung"],
  };

  const res = validateSemanticJurCaseAssignment(classification, registryIds);
  assert.equal(res.changed, true);
  assert.equal(res.classification.case_id, "Verwaltungsrecht_Bussgeld_Pflegeversicherung");
  assert.ok(res.classification.case_confidence >= 0.85);
});

test("semantic proposal: neues Strafdokument erzeugt proposed_case_id mit Strafrecht_", () => {
  const registryIds = new Set(["Unterhalt_Schoenlein"]);
  const classification = {
    domain: "jur",
    case_id: null,
    case_confidence: 0.4,
    title_suggestion: "Strafanzeige gegen Unbekannt",
    sender: "Polizeipräsidium Test",
    doc_type: "Schreiben",
    doc_tags: ["strafanzeige"],
  };

  const res = validateSemanticJurCaseAssignment(classification, registryIds, {
    autoCreateCase: false,
  });
  assert.equal(res.changed, true);
  assert.equal(res.reason, "proposal_created_unassigned");
  assert.equal(res.classification.case_id, null);
  assert.ok(res.classification.case_confidence < 0.8);
  assert.match(res.classification.proposed_case_id, /^Strafrecht_/);
});

test("semantic proposal: ohne Flag kein automatisches Anlegen", () => {
  const registryIds = new Set();
  const classification = {
    domain: "jur",
    case_id: null,
    case_confidence: 0.3,
    title_suggestion: "Strafantrag neu",
    sender: "Michael M. Schönlein",
    doc_type: "Schreiben",
  };

  const res = validateSemanticJurCaseAssignment(classification, registryIds, {
    autoCreateCase: false,
  });
  assert.equal(res.changed, true);
  assert.equal(res.reason, "proposal_created_unassigned");
  assert.equal(res.create_case, undefined);
  assert.equal(res.classification.case_id, null);
  assert.ok(typeof res.classification.proposed_case_id === "string");
});
