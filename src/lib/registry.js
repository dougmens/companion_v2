const { FILES } = require("./config");
const { readJson, writeJson } = require("./fsx");

function normalizeCaseId(caseId) {
  const s = String(caseId ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(s)) return null;
  return s;
}

async function loadRegistry(registryPath = FILES.caseRegistry) {
  const reg = await readJson(registryPath);
  if (!reg || !Array.isArray(reg.cases)) {
    throw new Error(`Invalid case registry: ${registryPath}`);
  }
  return reg;
}

function registryCaseIds(registry) {
  return registryActiveCaseIds(registry);
}

function registryActiveCaseIds(registry) {
  return new Set(
    (registry.cases || [])
      .filter((c) => c && typeof c === "object" && !c.archived)
      .map((c) => c.case_id)
      .filter(Boolean),
  );
}

function caseExists(registry, caseId) {
  const ids = registryCaseIds(registry);
  return ids.has(caseId);
}

async function addCase({
  case_id,
  title,
  aliasesCsv = "",
  tagsCsv = "",
  registryPath = FILES.caseRegistry,
}) {
  const registry = await loadRegistry(registryPath);
  const normalizedId = normalizeCaseId(case_id);
  if (!normalizedId) {
    throw new Error("case_id must match /^[A-Za-z0-9_]+$/");
  }
  if (caseExists(registry, normalizedId)) {
    throw new Error(`Duplicate case_id: ${normalizedId}`);
  }
  const aliases = String(aliasesCsv)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const tags = String(tagsCsv)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  registry.cases.push({
    case_id: normalizedId,
    title: String(title ?? "").trim() || normalizedId,
    aliases,
    tags,
  });

  await writeJson(registryPath, registry);
  return { registry, added: normalizedId };
}

async function updateCase({
  case_id,
  title,
  aliasesCsv,
  tagsCsv,
  registryPath = FILES.caseRegistry,
}) {
  const registry = await loadRegistry(registryPath);
  const normalizedId = normalizeCaseId(case_id);
  if (!normalizedId) {
    throw new Error("case_id must match /^[A-Za-z0-9_]+$/");
  }

  const idx = (registry.cases || []).findIndex((c) => c && c.case_id === normalizedId);
  if (idx < 0) {
    throw new Error(`Unknown case_id: ${normalizedId}`);
  }

  const current = registry.cases[idx];
  const next = { ...current };

  if (title !== undefined) {
    next.title = String(title ?? "").trim() || normalizedId;
  }
  if (aliasesCsv !== undefined) {
    next.aliases = String(aliasesCsv)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (tagsCsv !== undefined) {
    next.tags = String(tagsCsv)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  registry.cases[idx] = next;
  await writeJson(registryPath, registry);
  return { registry, updated: normalizedId };
}

module.exports = {
  addCase,
  caseExists,
  loadRegistry,
  normalizeCaseId,
  registryActiveCaseIds,
  registryCaseIds,
  updateCase,
};
