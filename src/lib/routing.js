const path = require("node:path");
const { DIRS } = require("./config");
const { jurCaseBaseDir } = require("./case_paths");

const FIN_SUBCATS = [
  "versicherung",
  "rechnung",
  "mahnung",
  "steuer",
  "bank",
  "inkasso",
  "sonstiges",
];

const ALLG_SUBCATS = [
  "vertrag",
  "korrespondenz",
  "identitaet",
  "behoerde",
  "sonstiges",
];

function normalizeToken(s) {
  return String(s ?? "").toLowerCase().trim();
}

function pickSubcategory(domain, classification) {
  const tags = Array.isArray(classification?.doc_tags)
    ? classification.doc_tags.map(normalizeToken).filter(Boolean)
    : [];
  const docType = normalizeToken(classification?.doc_type);
  const candidates = [...tags, docType].filter(Boolean);

  const containsAny = (needles) =>
    candidates.some((c) => needles.some((n) => c.includes(n)));

  if (domain === "fin") {
    if (containsAny(["versicher"])) return "versicherung";
    if (containsAny(["rechnung", "invoice", "honorar", "zahlung"])) return "rechnung";
    if (containsAny(["mahnung", "erinnerung", "verzug", "frist"])) return "mahnung";
    if (containsAny(["steuer", "finanzamt", "ust", "bescheid"])) return "steuer";
    if (containsAny(["bank", "konto", "iban", "kredit", "darlehen"])) return "bank";
    if (containsAny(["inkasso", "forderung", "collection"])) return "inkasso";
    return "sonstiges";
  }

  if (domain === "allg") {
    if (containsAny(["vertrag", "vereinbarung", "agb", "kaufvertrag", "mietvertrag"]))
      return "vertrag";
    if (containsAny(["korrespondenz", "anschreiben", "mitteilung", "brief", "email"]))
      return "korrespondenz";
    if (containsAny(["ausweis", "reisepass", "personalausweis", "identit"]))
      return "identitaet";
    if (containsAny(["behoerde", "behorde", "behörde", "amt", "antrag", "bescheid", "jobcenter"]))
      return "behoerde";
    return "sonstiges";
  }

  return "sonstiges";
}

function decideRouting(classification, registryCaseIdSet) {
  const domain = classification.domain;
  if (domain === "jur") {
    const caseId = classification.case_id;
    const confident =
      typeof classification.case_confidence === "number" &&
      classification.case_confidence >= 0.8;
    const caseKnown = caseId && registryCaseIdSet.has(caseId);
    if (caseKnown && confident) {
      const base = jurCaseBaseDir(DIRS.processedJurCases, caseId);
      return {
        route: "jur_case",
        domain,
        case_id: caseId,
        pdfDir: path.join(base, "pdf"),
        mdDir: path.join(base, "md"),
        metaDir: path.join(base, "meta"),
        evidenceDir: path.join(base, "evidence"),
      };
    }

    const base = path.join(DIRS.processedJurCases, "UNASSIGNED");
    return {
      route: "jur_unassigned",
      domain,
      case_id: null,
      pdfDir: path.join(base, "pdf"),
      mdDir: path.join(base, "md"),
      metaDir: path.join(base, "meta"),
      evidenceDir: path.join(base, "evidence"),
    };
  }

  if (domain === "fin") {
    const subcategory = pickSubcategory("fin", classification);
    const safeSubcat = FIN_SUBCATS.includes(subcategory) ? subcategory : "sonstiges";
    return {
      route: "finanzen",
      domain,
      subcategory: safeSubcat,
      pdfDir: path.join(DIRS.processedFin, safeSubcat),
    };
  }

  const subcategory = pickSubcategory("allg", classification);
  const safeSubcat = ALLG_SUBCATS.includes(subcategory) ? subcategory : "sonstiges";
  return {
    route: "allgemein",
    domain: "allg",
    subcategory: safeSubcat,
    pdfDir: path.join(DIRS.processedAllg, safeSubcat),
  };
}

module.exports = { decideRouting, pickSubcategory };
