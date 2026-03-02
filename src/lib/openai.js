const { normalizeDateWithPlausibility, fallbackDate } = require("./naming");
const { registryActiveCaseIds } = require("./registry");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function safeJsonParse(str) {
  try {
    return { ok: true, value: JSON.parse(str) };
  } catch (error) {
    return { ok: false, error };
  }
}

function clamp01(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeCurrency(cur) {
  if (cur === null) return null;
  const s = String(cur ?? "").toUpperCase().trim();
  if (!s) return null;
  if (s === "EUR") return "EUR";
  return null;
}

function enforceCaseIdRule(caseId, registryCaseIds) {
  if (caseId === null) return null;
  if (caseId === "NEW_CASE") return "NEW_CASE";
  if (typeof caseId !== "string") return null;
  if (registryCaseIds.has(caseId)) return caseId;
  return null;
}

function normalizeClassification(raw, registryCaseIds) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const domainRaw = String(obj.domain ?? "").trim();
  const domain = domainRaw === "jur" || domainRaw === "fin" || domainRaw === "allg" ? domainRaw : "allg";

  const dateNorm = normalizeDateWithPlausibility(obj.date);
  const date = dateNorm.date ?? fallbackDate();
  const dateWarnings = Array.isArray(dateNorm.warnings) ? dateNorm.warnings : [];

  const hasReasons = Array.isArray(obj.reasons);
  const reasons = hasReasons ? obj.reasons.map(String) : [];
  for (const w of dateWarnings) reasons.push(`date_normalization_warning:${w}`);

  const amount =
    obj.amount === null || obj.amount === undefined || obj.amount === ""
      ? null
      : String(obj.amount).trim();

  let doc_type = String(obj.doc_type ?? "").trim();
  if (!doc_type || doc_type === "string" || doc_type.length < 3) {
    doc_type = "Schreiben";
    if (hasReasons) reasons.push("doc_type invalid -> defaulted");
  }

  const currency = amount == null ? null : normalizeCurrency(obj.currency);

  return {
    doc_type,
    domain,
    date,
    date_warnings: dateWarnings,
    sender: String(obj.sender ?? "").trim() || "Unbekannt",
    amount,
    currency,
    title_suggestion: String(obj.title_suggestion ?? "").trim() || "Ohne Titel",
    case_id: enforceCaseIdRule(obj.case_id ?? null, registryCaseIds),
    case_confidence: clamp01(Number(obj.case_confidence ?? 0)),
    case_tags: Array.isArray(obj.case_tags) ? obj.case_tags.map(String) : [],
    doc_tags:
      Array.isArray(obj.doc_tags) && obj.doc_tags.length > 0
        ? obj.doc_tags.map(String).map((s) => s.trim()).filter(Boolean)
        : ["sonstiges"],
    aktenzeichen: obj.aktenzeichen ? String(obj.aktenzeichen).trim() : null,
    reasons,
  };
}

function buildClassificationPrompt({
  filename,
  registry,
  detectedAktenzeichen,
  textExcerpt,
}) {
  const cases = (registry.cases || [])
    .filter((c) => c && typeof c === "object" && !c.archived)
    .map((c) => ({
      case_id: c.case_id,
      title: c.title,
      aliases: c.aliases || [],
      tags: c.tags || [],
    }));

  const allowedCaseIds = cases.map((c) => c.case_id);

  const instructions = [
    "Du bist ein Dokumenten-Klassifikator. Antworte ausschließlich mit einem JSON-Objekt.",
    "WICHTIG: Du darfst niemals neue case_id erfinden.",
    `case_id MUSS entweder in dieser Liste sein, oder "NEW_CASE", oder null: ${JSON.stringify(
      allowedCaseIds,
    )}`,
    'date Format: "YYYY-MM-DD", "YYYY-MM-00" oder "YYYY-00-00".',
    'domain ist exakt eins von: "jur", "fin", "allg".',
    'currency ist "EUR" oder null.',
    "case_confidence ist eine Zahl 0..1.",
    "reasons ist ein Array kurzer Stichpunkte.",
  ].join("\n");

  const context = {
    filename,
    detected_aktenzeichen: detectedAktenzeichen,
    case_registry: cases,
    text_excerpt: textExcerpt,
  };

  const schema = {
    doc_type: "string",
    domain: "jur|fin|allg",
    date: "YYYY-MM-DD|YYYY-MM-00|YYYY-00-00",
    sender: "string",
    amount: "string|null",
    currency: "EUR|null",
    title_suggestion: "string",
    case_id: "one_of_registry|NEW_CASE|null",
    case_confidence: "number(0..1)",
    case_tags: "string[]",
    doc_tags: "string[]",
    aktenzeichen: "string|null",
    reasons: "string[]",
  };

  return [
    { role: "system", content: instructions },
    {
      role: "user",
      content: `${JSON.stringify({ schema, context })}`,
    },
  ];
}

function buildExcerpt(text, maxChars = 14_000) {
  const t = String(text ?? "");
  if (t.length <= maxChars) return t;
  const head = t.slice(0, Math.floor(maxChars * 0.7));
  const tail = t.slice(t.length - Math.floor(maxChars * 0.3));
  return `${head}\n\n[...gekürzt...]\n\n${tail}`;
}

async function classifyDocument({ filename, text, registry, detectedAktenzeichen }) {
  // Lazy-load dependency so unit tests can run without npm install.
  // eslint-disable-next-line global-require
  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });

  const registryCaseIds = registryActiveCaseIds(registry);

  const messages = buildClassificationPrompt({
    filename,
    registry,
    detectedAktenzeichen,
    textExcerpt: buildExcerpt(text),
  });

  const model = process.env.OPENAI_CLASSIFY_MODEL || "gpt-4o-mini";
  let resp;
  try {
    resp = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
  } catch (error) {
    // Compatibility fallback for SDK/API variants that don't support response_format.
    resp = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.1,
    });
  }

  const content = resp?.choices?.[0]?.message?.content ?? "";
  const parsed = safeJsonParse(content);
  if (!parsed.ok) {
    throw new Error(`Model did not return valid JSON. Content: ${content.slice(0, 500)}`);
  }

  return normalizeClassification(parsed.value, registryCaseIds);
}

async function embedTexts(texts, { model } = {}) {
  // eslint-disable-next-line global-require
  const OpenAI = require("openai");
  const client = new OpenAI({ apiKey: mustEnv("OPENAI_API_KEY") });

  const embedModel =
    model || process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

  const resp = await client.embeddings.create({
    model: embedModel,
    input: texts,
  });

  const data = resp?.data ?? [];
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new Error("Unexpected embeddings response shape");
  }
  return data.map((d) => d.embedding);
}

module.exports = {
  classifyDocument,
  embedTexts,
  enforceCaseIdRule,
  normalizeClassification,
};
