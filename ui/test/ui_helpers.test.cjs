const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function loadHelpers() {
  const file = path.resolve(__dirname, "..", "src", "lib", "ui_helpers.js");
  return import(pathToFileURL(file).href);
}

test("filterEvents filters by type/domain/entity", async () => {
  const { filterEvents } = await loadHelpers();
  const events = [
    { type: "a", domain: "x", entity_id: "foo" },
    { type: "b", domain: "x", entity_id: "bar" },
    { type: "a", domain: "y", entity_id: "baz" },
  ];

  const out = filterEvents(events, { type: "a", domain: "x", entity: "fo" });
  assert.equal(out.length, 1);
  assert.equal(out[0].entity_id, "foo");
});

test("normalizeDashboardState handles empty input", async () => {
  const { normalizeDashboardState } = await loadHelpers();
  const state = normalizeDashboardState(null);

  assert.equal(Array.isArray(state.cases), true);
  assert.equal(Array.isArray(state.events), true);
  assert.equal(Array.isArray(state.reports), true);
  assert.equal(Array.isArray(state.intents), true);
  assert.equal(state.inbox.count, 0);
  assert.equal(state.documents.total, 0);
});

test("caseCardText returns stable summary", async () => {
  const { caseCardText } = await loadHelpers();
  const text = caseCardText({
    case_id: "Unterhalt_Schoenlein",
    title: "Unterhalt",
    runtime: { urgency: "attention" },
  });

  assert.equal(text.includes("Unterhalt_Schoenlein"), true);
  assert.equal(text.includes("Unterhalt"), true);
  assert.equal(text.includes("attention"), true);
});
