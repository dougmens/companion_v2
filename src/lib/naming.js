const { clampLength, sanitizeForFilename } = require("./sanitize");

const DEFAULT_MIN_YEAR = 1990;

function pad2(v) {
  return String(v).padStart(2, "0");
}

function normalizeForFilename(input) {
  const s = String(input ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeForFilename(s);
}

function parseDateParts(dateStr) {
  if (typeof dateStr !== "string") return null;
  const s = dateStr.trim();
  if (!s) return null;

  // Full date (YYYY-MM-DD)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      precision: "day",
    };
  }

  // Month/year (YYYY-MM) or (MM/YYYY) or (MM.YYYY)
  m = s.match(/^(\d{4})-(\d{2})$/);
  if (m) {
    return {
      year: Number(m[1]),
      month: Number(m[2]),
      day: 0,
      precision: "month",
    };
  }

  m = s.match(/^(\d{2})[/.](\d{4})$/);
  if (m) {
    return {
      year: Number(m[2]),
      month: Number(m[1]),
      day: 0,
      precision: "month",
    };
  }

  // Year only (YYYY)
  m = s.match(/^(\d{4})$/);
  if (m) {
    return {
      year: Number(m[1]),
      month: 0,
      day: 0,
      precision: "year",
    };
  }

  return null;
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year
    && (dt.getUTCMonth() + 1) === month
    && dt.getUTCDate() === day
  );
}

function normalizeDateWithPlausibility(dateStr, {
  minYear = DEFAULT_MIN_YEAR,
  maxYear = new Date().getFullYear() + 1,
  unknownDate = "0000-00-00",
} = {}) {
  const warnings = [];
  const parsed = parseDateParts(dateStr);
  if (!parsed) {
    return { date: null, warnings };
  }

  const { year, month, day, precision } = parsed;
  if (!Number.isInteger(year)) {
    return { date: null, warnings };
  }

  if (year < minYear || year > maxYear) {
    warnings.push(`date_year_out_of_range:${year} (expected ${minYear}..${maxYear})`);
    return { date: unknownDate, warnings };
  }

  if (precision === "year") {
    return { date: `${year}-00-00`, warnings };
  }

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    warnings.push(`date_month_invalid:${month}`);
    return { date: `${year}-00-00`, warnings };
  }

  if (precision === "month") {
    return { date: `${year}-${pad2(month)}-00`, warnings };
  }

  if (!isValidCalendarDate(year, month, day)) {
    warnings.push(`date_day_invalid:${year}-${pad2(month)}-${pad2(day)}`);
    return { date: `${year}-${pad2(month)}-00`, warnings };
  }

  return { date: `${year}-${pad2(month)}-${pad2(day)}`, warnings };
}

function normalizeDate(dateStr, opts) {
  return normalizeDateWithPlausibility(dateStr, opts).date;
}

function ensureYear(dateStr) {
  if (typeof dateStr !== "string") return null;
  const m = dateStr.match(/^(\d{4})-/);
  return m ? m[1] : null;
}

function fallbackDate() {
  return "0000-00-00";
}

function buildPdfBaseName({
  date,
  doc_type,
  sender,
  title_suggestion,
  domain,
  maxLen = 120,
}) {
  const safeDate = normalizeDate(date) ?? fallbackDate();
  const rawDocType = normalizeForFilename(doc_type);
  const rawSender = normalizeForFilename(sender);
  const rawTitle = normalizeForFilename(title_suggestion);

  let safeDocType = clampLength(rawDocType || "Schreiben", 30) || "Schreiben";
  const safeSender = clampLength(rawSender || "Unbekannt", 40) || "Unbekannt";
  const safeTitle = clampLength(rawTitle || "Dokument", 50) || "Dokument";

  if (safeDocType === "Schreiben" && domain === "fin") {
    safeDocType = "Finanzdokument";
  }

  const base = `${safeDate} ${safeDocType} ${safeSender} - ${safeTitle}`.replace(
    /\s+/g,
    " ",
  );
  return clampLength(base, maxLen);
}

function buildPdfFilename(fields) {
  return `${buildPdfBaseName(fields)}.pdf`;
}

module.exports = {
  buildPdfBaseName,
  buildPdfFilename,
  DEFAULT_MIN_YEAR,
  ensureYear,
  fallbackDate,
  normalizeDate,
  normalizeDateWithPlausibility,
  normalizeForFilename,
};
