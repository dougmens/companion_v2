const path = require("node:path");
const { appendLine, ensureDir } = require("./fsx");
const { DIRS } = require("./config");

function isoDateOnly(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function isoTime(date = new Date()) {
  return date.toISOString();
}

function formatLine(level, message, data) {
  const ts = isoTime();
  if (data === undefined) return `${ts} [${level}] ${message}`;
  return `${ts} [${level}] ${message} ${JSON.stringify(data)}`;
}

function createLogger() {
  const logFile = path.join(DIRS.logs, `${isoDateOnly()}.log`);

  async function log(level, message, data) {
    await ensureDir(DIRS.logs);
    const line = formatLine(level, message, data);
    await appendLine(logFile, line);
    if (level === "ERROR") {
      // eslint-disable-next-line no-console
      console.error(line);
    } else {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }

  return {
    info: (msg, data) => log("INFO", msg, data),
    warn: (msg, data) => log("WARN", msg, data),
    error: (msg, data) => log("ERROR", msg, data),
  };
}

module.exports = { createLogger, isoDateOnly };

