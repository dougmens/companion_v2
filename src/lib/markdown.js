function yamlQuote(str) {
  return JSON.stringify(String(str ?? ""));
}

function toYamlFrontmatter(obj) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlQuote(item)}`);
      continue;
    }
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
      continue;
    }
    lines.push(`${key}: ${yamlQuote(value)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n`;
}

function buildMarkdown({ frontmatter, text }) {
  const fm = toYamlFrontmatter(frontmatter || {});
  const body = String(text ?? "");
  return `${fm}${body}\n`;
}

module.exports = { buildMarkdown };

