function normalizeAktenzeichen(az) {
  return String(az ?? "")
    .replace(/\s+/g, " ")
    .replace(/^Az\.?:?\s*/i, "")
    .trim()
    .toUpperCase();
}

function extractAktenzeichen(text) {
  const t = String(text ?? "");
  const patterns = [
    /\bAz\.?:?\s*([0-9]{1,3}\s*[A-ZÄÖÜ]{1,4}\s*[0-9]{1,6}\/[0-9]{2})\b/gi,
    /\b([0-9]{1,3}\s*[A-ZÄÖÜ]{1,4}\s*[0-9]{1,6}\/[0-9]{2})\b/gi,
    /\b([A-ZÄÖÜ]{1,3}\s*[0-9]{1,6}\/[0-9]{2})\b/gi,
  ];

  const matches = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t))) {
      const candidate = normalizeAktenzeichen(m[1] || m[0]);
      if (candidate && !matches.includes(candidate)) matches.push(candidate);
      if (matches.length >= 10) break;
    }
    if (matches.length >= 10) break;
  }

  return {
    best: matches[0] ?? null,
    all: matches,
  };
}

module.exports = { extractAktenzeichen };

