function toAscii(input) {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function toCaseIdSlug(input, { maxLen = 40 } = {}) {
  const ascii = toAscii(String(input ?? "").replace(/ß/g, "ss"));
  const cleaned = ascii
    .replace(/&/g, " und ")
    .replace(/[@]/g, " at ")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .trim();

  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).replace(/_+$/g, "");
}

function sanitizeForFilename(input) {
  const ascii = toAscii(input);
  const cleaned = ascii
    .replace(/&/g, " und ")
    .replace(/[@]/g, " at ")
    .replace(/[^A-Za-z0-9 ._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

function clampLength(str, maxLen) {
  const s = String(str ?? "");
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen).trim();
}

module.exports = { clampLength, sanitizeForFilename, toAscii, toCaseIdSlug };
