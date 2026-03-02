async function extractPdfText(pdfPath) {
  // Lazy-load dependency so unit tests can run without npm install.
  // eslint-disable-next-line global-require
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(await require("node:fs/promises").readFile(pdfPath));
  return {
    text: String(data.text ?? ""),
    numpages: data.numpages ?? null,
    info: data.info ?? null,
    metadata: data.metadata ?? null,
  };
}

module.exports = { extractPdfText };

