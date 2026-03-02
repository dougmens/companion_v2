function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? "").length / 4));
}

function takeTailByTokens(text, tokenCount) {
  const chars = tokenCount * 4;
  const t = String(text ?? "");
  if (t.length <= chars) return t;
  return t.slice(t.length - chars);
}

function splitIntoUnits(text) {
  const t = String(text ?? "").replace(/\r\n/g, "\n");
  return t
    .split(/\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function chunkText({
  text,
  minTokens = 800,
  maxTokens = 1200,
  overlapTokens = 100,
}) {
  const units = splitIntoUnits(text);
  const chunks = [];
  let current = "";

  function pushChunk(chunk) {
    const c = chunk.trim();
    if (!c) return;
    chunks.push(c);
  }

  for (const unit of units) {
    const next = current ? `${current}\n\n${unit}` : unit;
    if (estimateTokens(next) <= maxTokens) {
      current = next;
      continue;
    }

    if (current) {
      pushChunk(current);
      const overlap = takeTailByTokens(current, overlapTokens);
      current = overlap ? `${overlap}\n\n${unit}` : unit;
      if (estimateTokens(current) > maxTokens) {
        // Worst case: unit itself is huge; hard-cut by chars.
        const hard = String(current).slice(0, maxTokens * 4);
        pushChunk(hard);
        current = "";
      }
      continue;
    }

    // current empty but unit too large
    const hard = String(unit).slice(0, maxTokens * 4);
    pushChunk(hard);
    current = "";
  }

  if (current) pushChunk(current);

  // Ensure minimum tokens by merging small tail if needed.
  if (chunks.length >= 2) {
    const last = chunks[chunks.length - 1];
    if (estimateTokens(last) < minTokens) {
      const prev = chunks[chunks.length - 2];
      chunks.splice(chunks.length - 2, 2, `${prev}\n\n${last}`.trim());
    }
  }

  return chunks;
}

module.exports = { chunkText, estimateTokens };

