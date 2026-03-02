const path = require("node:path");

const { ensureDir, writeJson } = require("./fsx");
const { jurCaseBaseDir } = require("./case_paths");
const { toAscii, toCaseIdSlug } = require("./sanitize");

function uniq(items) {
  const out = [];
  const seen = new Set();
  for (const v of items) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function normalizeSignalValue(s) {
  return toAscii(String(s ?? ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReference(s) {
  return toAscii(String(s ?? ""))
    .toUpperCase()
    .replace(/\s+/g, "")
    .trim();
}

function extractInternalReferences(text) {
  const t = String(text ?? "");
  const re = /\b([A-Z]-\d{1,5}\/\d{4})\b/g;
  const matches = [];
  let m;
  while ((m = re.exec(t))) {
    const val = normalizeReference(m[1]);
    if (val && !matches.includes(val)) matches.push(val);
    if (matches.length >= 10) break;
  }
  return matches;
}

function extractPartyEntities(text) {
  const t = String(text ?? "");
  const out = [];

  const labeledRe =
    /\b(?:Kläger(?:in)?|Beklagte(?:r)?|Antragsgegner(?:in)?|Antragsteller(?:in)?|Partei|Firma|Unternehmen)\s*[:\-]\s*([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{2,80})/g;
  let m;
  while ((m = labeledRe.exec(t))) {
    const val = String(m[1] ?? "").replace(/\s+/g, " ").trim();
    if (val && !out.includes(val)) out.push(val);
    if (out.length >= 10) break;
  }

  const companyRe =
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{1,80}?\s(?:GmbH|AG|UG|KG|OHG|GbR|SE|e\.V\.|LLC|Ltd\.?|Inc\.?))\b/g;
  while ((m = companyRe.exec(t))) {
    const val = String(m[1] ?? "").replace(/\s+/g, " ").trim();
    if (val && !out.includes(val)) out.push(val);
    if (out.length >= 10) break;
  }

  // Simple heuristics for "X gegen Y" / "X ./. Y" patterns
  const versusRe =
    /\b([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{1,80}?)\s+(?:gegen|\.\/\.)\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß&.\- ]{1,80}?)\b/gi;
  while ((m = versusRe.exec(t))) {
    const left = String(m[1] ?? "").replace(/\s+/g, " ").trim();
    const right = String(m[2] ?? "").replace(/\s+/g, " ").trim();
    if (left && !out.includes(left)) out.push(left);
    if (right && !out.includes(right)) out.push(right);
    if (out.length >= 10) break;
  }

  return out;
}

function collectCaseSignals({ classification, text, detectedAktenzeichen }) {
  const senderRaw = String(classification?.sender ?? "").trim();
  const sender = senderRaw || "";
  const senderHard = !!sender && normalizeSignalValue(sender) !== "unbekannt";

  const senderKey = normalizeSignalValue(sender);
  const parties = extractPartyEntities(text).filter((p) => normalizeSignalValue(p) !== senderKey);
  const references = extractInternalReferences(text);
  const aktenzeichen = detectedAktenzeichen ? [String(detectedAktenzeichen)] : [];

  return {
    sender,
    senderHard,
    parties,
    references,
    aktenzeichen,
  };
}

function hasHardSignalsForNewCase(signals) {
  if (!signals?.senderHard) return false;
  const hasOther =
    (signals.aktenzeichen || []).length > 0 ||
    (signals.references || []).length > 0 ||
    (signals.parties || []).length > 0;
  return hasOther;
}

function findReusableCaseId(registry, signals) {
  const senderKey = normalizeSignalValue(signals.sender);
  if (!senderKey) return null;

  const partyKeys = new Set((signals.parties || []).map(normalizeSignalValue).filter(Boolean));
  const refKeys = new Set(
    [...(signals.references || []), ...(signals.aktenzeichen || [])]
      .map(normalizeReference)
      .filter(Boolean),
  );

  if (partyKeys.size === 0 || refKeys.size === 0) return null;

  for (const c of registry?.cases || []) {
    if (!c || typeof c !== "object") continue;
    if (c.archived) continue;
    const s = c.signals;
    if (!s || typeof s !== "object") continue;

    const csender = normalizeSignalValue(s.sender);
    if (!csender || csender !== senderKey) continue;

    const cPartyKeys = new Set(
      Array.isArray(s.parties) ? s.parties.map(normalizeSignalValue).filter(Boolean) : [],
    );
    const cRefKeys = new Set(
      [
        ...(Array.isArray(s.references) ? s.references : []),
        ...(Array.isArray(s.aktenzeichen) ? s.aktenzeichen : []),
      ]
        .map(normalizeReference)
        .filter(Boolean),
    );

    const partyMatch = [...partyKeys].some((p) => cPartyKeys.has(p));
    const refMatch = [...refKeys].some((r) => cRefKeys.has(r));
    if (partyMatch && refMatch) return c.case_id || null;
  }

  return null;
}

function buildNewCaseTitle({ classification, signals }) {
  const mainParty = signals.parties?.[0] || "Neuer Fall";
  const topic =
    String(classification?.title_suggestion ?? "").trim() ||
    String(classification?.doc_type ?? "").trim() ||
    "Fall";
  const title = `${mainParty} - ${topic}`.replace(/\s+/g, " ").trim();
  return title.length > 120 ? `${title.slice(0, 120).trim()}…` : title;
}

function buildNewCaseIdBase({ classification, signals }) {
  const mainParty = signals.parties?.[0] || signals.sender || "Case";
  const identifier =
    signals.references?.[0] ||
    signals.aktenzeichen?.[0] ||
    String(classification?.title_suggestion ?? "").trim() ||
    String(classification?.doc_type ?? "").trim() ||
    "Fall";

  const left = toCaseIdSlug(mainParty, { maxLen: 24 });
  const right = toCaseIdSlug(identifier, { maxLen: 24 });
  const base = toCaseIdSlug([left, right].filter(Boolean).join("_"), { maxLen: 40 });
  return base || toCaseIdSlug(mainParty, { maxLen: 40 }) || "Case";
}

function pickUniqueCaseId(existingIds, base) {
  const baseSlug = toCaseIdSlug(base, { maxLen: 40 }) || "Case";
  if (!existingIds.has(baseSlug)) return baseSlug;
  for (let i = 2; i < 10_000; i++) {
    const suffix = `_${i}`;
    const head = baseSlug.slice(0, Math.max(0, 40 - suffix.length)).replace(/_+$/g, "");
    const candidate = `${head}${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error(`Could not find unique case_id for base: ${baseSlug}`);
}

async function ensureCaseFolders(processedJurCasesDir, caseId) {
  const base = jurCaseBaseDir(processedJurCasesDir, caseId);
  await Promise.all([
    ensureDir(path.join(base, "pdf")),
    ensureDir(path.join(base, "md")),
    ensureDir(path.join(base, "meta")),
    ensureDir(path.join(base, "evidence")),
  ]);
  return base;
}

function needsAutoCaseCreation(classification) {
  if (classification?.domain !== "jur") return false;
  const caseId = classification.case_id;
  const confidence = Number(classification.case_confidence ?? 0);
  return caseId == null || caseId === "NEW_CASE" || confidence < 0.8;
}

function isExistingCaseAssignmentSupportedBySignals({ classification, signals }) {
  if (classification?.domain !== "jur") return true;
  if (!classification?.case_id || classification.case_id === "NEW_CASE") return true;
  if (Number(classification.case_confidence ?? 0) < 0.8) return false;
  const hasAnySignal =
    (signals.aktenzeichen || []).length > 0 ||
    (signals.references || []).length > 0 ||
    (signals.parties || []).length > 0;
  return hasAnySignal;
}

async function maybeAutoCreateJurCase({
  classification,
  text,
  detectedAktenzeichen,
  registry,
  registryPath,
  processedJurCasesDir,
}) {
  const signals = collectCaseSignals({ classification, text, detectedAktenzeichen });

  if (!isExistingCaseAssignmentSupportedBySignals({ classification, signals })) {
    return {
      action: "cleared_unsupported_case",
      signals,
      registry,
      classification: {
        ...classification,
        case_id: null,
        case_confidence: Math.min(Number(classification.case_confidence ?? 0), 0.79),
      },
    };
  }

  if (!needsAutoCaseCreation(classification)) {
    return { action: "none", signals, registry, classification };
  }

  if (!hasHardSignalsForNewCase(signals)) {
    return {
      action: "no_hard_signals",
      signals,
      registry,
      classification: {
        ...classification,
        case_id: null,
        case_confidence: Math.min(Number(classification.case_confidence ?? 0), 0.79),
      },
    };
  }

  const reused = findReusableCaseId(registry, signals);
  if (reused) {
    return {
      action: "reused",
      signals,
      registry,
      classification: {
        ...classification,
        case_id: reused,
        case_confidence: Math.max(Number(classification.case_confidence ?? 0), 0.85),
      },
    };
  }

  const existingIds = new Set(
    (registry?.cases || []).map((c) => c?.case_id).filter(Boolean),
  );
  const base = buildNewCaseIdBase({ classification, signals });
  const newCaseId = pickUniqueCaseId(existingIds, base);

  await ensureCaseFolders(processedJurCasesDir, newCaseId);

  const entry = {
    case_id: newCaseId,
    title: buildNewCaseTitle({ classification, signals }),
    aliases: uniq([
      normalizeSignalValue(signals.sender),
      ...(signals.parties || []).map(normalizeSignalValue),
      ...(signals.references || []).map(normalizeReference),
      ...(signals.aktenzeichen || []).map(normalizeReference),
    ]).filter(Boolean),
    tags: uniq([...(classification.case_tags || []), "autocreated"]),
    signals: {
      sender: signals.sender,
      parties: uniq(signals.parties || []),
      references: uniq(signals.references || []),
      aktenzeichen: uniq(signals.aktenzeichen || []),
    },
  };

  const nextRegistry = {
    ...(registry || {}),
    version: registry?.version ?? 1,
    cases: [...(registry?.cases || []), entry],
  };

  await writeJson(registryPath, nextRegistry);

  return {
    action: "created",
    signals,
    registry: nextRegistry,
    classification: {
      ...classification,
      case_id: newCaseId,
      case_confidence: Math.max(Number(classification.case_confidence ?? 0), 0.85),
    },
    created_case_id: newCaseId,
  };
}

module.exports = {
  collectCaseSignals,
  extractInternalReferences,
  extractPartyEntities,
  findReusableCaseId,
  hasHardSignalsForNewCase,
  maybeAutoCreateJurCase,
  needsAutoCaseCreation,
  pickUniqueCaseId,
};
