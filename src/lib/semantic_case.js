const { toAscii, toCaseIdSlug } = require("./sanitize");

const SEMANTIC_CASE_IDS = {
  unterhalt: "Familienrecht_Unterhalt_Schoenlein",
  strafanzeigen: "Strafrecht_Strafanzeigen_Schoenlein",
  bussgeld: "Verwaltungsrecht_Bussgeld_Pflegeversicherung",
  beratungshilfe: "Strafrecht_Beratungshilfe_Strafverfahren",
  versicherung: "Versicherungsrecht_Versicherungen_ARAG",
};

const NEGATIVE_UNTERHALT_KEYWORDS = [
  "strafanzeige",
  "strafantrag",
  "bussgeld",
  "bußgeld",
  "versicherung",
  "pflegeversicherung",
];

function normalizeText(input) {
  return toAscii(String(input ?? "").toLowerCase()).replace(/\s+/g, " ").trim();
}

function collectSemanticText(classification, text = "") {
  const joined = [
    classification?.doc_type,
    classification?.title_suggestion,
    classification?.sender,
    ...(Array.isArray(classification?.doc_tags) ? classification.doc_tags : []),
    ...(Array.isArray(classification?.case_tags) ? classification.case_tags : []),
    ...(Array.isArray(classification?.reasons) ? classification.reasons : []),
    text,
  ].join(" | ");
  return normalizeText(joined);
}

function containsAny(haystack, needles) {
  return needles.some((n) => haystack.includes(normalizeText(n)));
}

function inferSemanticCaseId(classification, { text = "" } = {}) {
  const signal = collectSemanticText(classification, text);

  if (
    containsAny(signal, [
      "beratungshilfe",
      "gerichtliche aufforderung",
      "amtsgericht",
      "cs ",
      " js ",
      "strafverfahren",
    ])
  ) {
    return SEMANTIC_CASE_IDS.beratungshilfe;
  }

  if (
    containsAny(signal, [
      "bußgeld",
      "bussgeld",
      "pflegeversicherungspflicht",
      "ordnungswidrigkeit",
      "landratsamt",
    ])
  ) {
    return SEMANTIC_CASE_IDS.bussgeld;
  }

  if (
    containsAny(signal, [
      "strafanzeige",
      "strafantrag",
      "koerperverletzung",
      "korperverletzung",
      "polizeipraesidium",
      "polizei",
    ])
  ) {
    return SEMANTIC_CASE_IDS.strafanzeigen;
  }

  if (
    containsAny(signal, [
      "versicherung",
      "krankenversicherung",
      "arag",
      "dauerzulageantrag",
    ])
  ) {
    return SEMANTIC_CASE_IDS.versicherung;
  }

  if (containsAny(signal, ["unterhalt", "kostennote", "familie"])) {
    return SEMANTIC_CASE_IDS.unterhalt;
  }

  return null;
}

function confidentKnownCaseId(classification, registryCaseIdSet) {
  const caseId = classification?.case_id;
  const confidence = Number(classification?.case_confidence ?? 0);
  if (!caseId || caseId === "NEW_CASE") return null;
  if (!registryCaseIdSet.has(caseId)) return null;
  if (confidence < 0.8) return null;
  return caseId;
}

function inferProposalCategory(classification, { text = "" } = {}) {
  const signal = collectSemanticText(classification, text);
  if (
    containsAny(signal, [
      "beratungshilfe",
      "gerichtliche aufforderung",
      "amtsgericht",
      "cs ",
      " js ",
      "strafverfahren",
    ])
  ) {
    return { legalArea: "Strafrecht", topic: "Beratungshilfe", partyFallback: "Strafverfahren" };
  }
  if (
    containsAny(signal, [
      "bußgeld",
      "bussgeld",
      "pflegeversicherungspflicht",
      "ordnungswidrigkeit",
      "landratsamt",
    ])
  ) {
    return { legalArea: "Verwaltungsrecht", topic: "Bussgeld", partyFallback: "Pflegeversicherung" };
  }
  if (
    containsAny(signal, [
      "strafanzeige",
      "strafantrag",
      "koerperverletzung",
      "korperverletzung",
      "polizeipraesidium",
      "polizei",
    ])
  ) {
    return { legalArea: "Strafrecht", topic: "Strafsache", partyFallback: "Schoenlein" };
  }
  if (
    containsAny(signal, [
      "versicherung",
      "krankenversicherung",
      "arag",
      "dauerzulageantrag",
    ])
  ) {
    return { legalArea: "Versicherungsrecht", topic: "Versicherung", partyFallback: "Schoenlein" };
  }
  return { legalArea: "Familienrecht", topic: "Unterhalt", partyFallback: "Schoenlein" };
}

function proposalParty(classification, fallbackParty) {
  const sender = String(classification?.sender ?? "").trim();
  if (!sender || normalizeText(sender) === "unbekannt") return fallbackParty;
  const compact = toAscii(sender).replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return fallbackParty;
  const parts = compact.split(" ").filter(Boolean);
  return parts[parts.length - 1] || fallbackParty;
}

function buildProposedCaseId(classification, { text = "" } = {}) {
  const category = inferProposalCategory(classification, { text });
  const titleTopic = toCaseIdSlug(String(classification?.title_suggestion ?? ""), { maxLen: 24 });
  const topic = titleTopic || toCaseIdSlug(category.topic, { maxLen: 24 }) || "Fall";
  const party = toCaseIdSlug(proposalParty(classification, category.partyFallback), { maxLen: 24 }) || "Beteiligter";
  const legalArea = toCaseIdSlug(category.legalArea, { maxLen: 24 }) || "Rechtsgebiet";
  return toCaseIdSlug(`${legalArea}_${topic}_${party}`, { maxLen: 72 }) || "Rechtsgebiet_Fall_Beteiligter";
}

function clearProposalFields(classification) {
  if (!classification || typeof classification !== "object") return classification;
  const { proposed_case_id, ...rest } = classification;
  return rest;
}

function validateSemanticJurCaseAssignment(classification, registryCaseIdSet, { text = "", autoCreateCase = false } = {}) {
  if (classification?.domain !== "jur") {
    return { classification, changed: false, reason: "non_jur_domain" };
  }

  const currentCaseId = classification?.case_id ?? null;
  const knownConfident = confidentKnownCaseId(classification, registryCaseIdSet);
  if (knownConfident && currentCaseId !== "Unterhalt_Schoenlein") {
    return {
      changed: false,
      reason: "known_confident_case",
      classification: clearProposalFields(classification),
    };
  }

  const signal = collectSemanticText(classification, text);
  const negativeForUnterhalt = containsAny(signal, NEGATIVE_UNTERHALT_KEYWORDS);
  const semanticCaseId = inferSemanticCaseId(classification, { text });
  const semanticCaseKnown = semanticCaseId && registryCaseIdSet.has(semanticCaseId);

  if (
    semanticCaseKnown &&
    (currentCaseId == null ||
      currentCaseId === "NEW_CASE" ||
      currentCaseId === "Unterhalt_Schoenlein" ||
      (negativeForUnterhalt && currentCaseId !== semanticCaseId))
  ) {
    return {
      changed: true,
      reason: "semantic_reassignment",
      classification: {
        ...clearProposalFields(classification),
        case_id: semanticCaseId,
        case_confidence: Math.max(Number(classification?.case_confidence ?? 0), 0.85),
      },
    };
  }

  if (currentCaseId === "Unterhalt_Schoenlein" && negativeForUnterhalt) {
    return {
      changed: true,
      reason: "negative_filter_unterhalt",
      classification: {
        ...clearProposalFields(classification),
        case_id: null,
        case_confidence: Math.min(Number(classification?.case_confidence ?? 0), 0.79),
      },
    };
  }

  if (knownConfident) {
    return {
      changed: false,
      reason: "known_confident_case",
      classification: clearProposalFields(classification),
    };
  }

  const proposedCaseId = buildProposedCaseId(classification, { text });
  if (autoCreateCase) {
    const alreadyExists = registryCaseIdSet.has(proposedCaseId);
    if (alreadyExists) {
      return {
        changed: true,
        reason: "proposal_existing_case_assigned",
        classification: {
          ...clearProposalFields(classification),
          case_id: proposedCaseId,
          case_confidence: Math.max(Number(classification?.case_confidence ?? 0), 0.85),
        },
      };
    }

    return {
      changed: true,
      reason: "proposal_auto_create",
      create_case: {
        case_id: proposedCaseId,
        title: `Auto ${proposedCaseId.replaceAll("_", " ")}`,
        aliases: [normalizeText(classification?.sender), normalizeText(classification?.title_suggestion)].filter(Boolean),
        tags: ["autocreated", "semantic-proposal"],
      },
      classification: {
        ...classification,
        proposed_case_id: proposedCaseId,
      },
    };
  }

  return {
    changed: true,
    reason: "proposal_created_unassigned",
    classification: {
      ...clearProposalFields(classification),
      case_id: null,
      case_confidence: Math.min(Number(classification?.case_confidence ?? 0), 0.79),
      proposed_case_id: proposedCaseId,
    },
  };
}

module.exports = {
  NEGATIVE_UNTERHALT_KEYWORDS,
  SEMANTIC_CASE_IDS,
  buildProposedCaseId,
  collectSemanticText,
  inferProposalCategory,
  inferSemanticCaseId,
  validateSemanticJurCaseAssignment,
};
