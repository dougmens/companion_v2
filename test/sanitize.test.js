const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeForFilename, toCaseIdSlug } = require("../src/lib/sanitize");

test("sanitizeForFilename produces ASCII-safe names and collapses whitespace", () => {
  const out = sanitizeForFilename("ÄÖÜß – Räumung #1: Müller & Söhne");
  assert.match(out, /^[A-Za-z0-9 ._-]*$/);
  assert.ok(!/\s{2,}/.test(out), `has multiple spaces: "${out}"`);
});

test("toCaseIdSlug creates strict [A-Za-z0-9_] slugs with maxLen", () => {
  const out = toCaseIdSlug("ÄÖÜß – Räumung #1: Müller & Söhne", { maxLen: 40 });
  assert.match(out, /^[A-Za-z0-9_]{1,40}$/);
});
