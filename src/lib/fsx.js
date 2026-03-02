const fs = require("node:fs/promises");
const fssync = require("node:fs");
const path = require("node:path");

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function moveFile(srcPath, destPath) {
  await ensureDir(path.dirname(destPath));
  try {
    await fs.rename(srcPath, destPath);
  } catch (error) {
    if (error && error.code === "EXDEV") {
      await fs.copyFile(srcPath, destPath);
      await fs.unlink(srcPath);
      return;
    }
    throw error;
  }
}

async function getUniquePath(destPath) {
  if (!(await pathExists(destPath))) return destPath;
  const dir = path.dirname(destPath);
  const ext = path.extname(destPath);
  const base = path.basename(destPath, ext);
  for (let i = 2; i < 10_000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  throw new Error(`Could not find unique filename for: ${destPath}`);
}

function isPdfFilename(filename) {
  return typeof filename === "string" && filename.toLowerCase().endsWith(".pdf");
}

function safeBasename(filePath) {
  return path.basename(filePath);
}

function safeRelative(from, to) {
  try {
    return path.relative(from, to);
  } catch {
    return to;
  }
}

async function readJson(jsonPath) {
  const raw = await fs.readFile(jsonPath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(jsonPath, obj) {
  const dir = path.dirname(jsonPath);
  await ensureDir(dir);
  await fs.writeFile(jsonPath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
}

async function listFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(dirPath, e.name));
}

async function listFilesRecursive(dirPath) {
  const out = [];
  async function walk(p) {
    let entries;
    try {
      entries = await fs.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await walk(dirPath);
  return out;
}

async function statSafe(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function fsWatchAvailable() {
  return typeof fssync.watch === "function";
}

module.exports = {
  appendLine,
  ensureDir,
  fsWatchAvailable,
  getUniquePath,
  isPdfFilename,
  listFiles,
  listFilesRecursive,
  moveFile,
  pathExists,
  readJson,
  safeBasename,
  safeRelative,
  statSafe,
  writeJson,
};
