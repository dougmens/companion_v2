const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { ROOT } = require("../lib/config");

const BLOCKED_DIRS = [
  "40_rag_index",
  "50_events",
  "60_intents",
  "70_runtime",
  "90_logs",
];

function normalizePathLike(value) {
  if (typeof value !== "string") return null;
  if (!value.trim()) return null;
  return value;
}

function isBlockedPath(rawPath) {
  const normalized = normalizePathLike(rawPath);
  if (!normalized) return false;

  const abs = path.resolve(process.cwd(), normalized);

  for (const dirName of BLOCKED_DIRS) {
    const blockedBase = path.resolve(ROOT, dirName);
    if (abs === blockedBase) return true;
    if (abs.startsWith(`${blockedBase}${path.sep}`)) return true;
  }

  return false;
}

function assertAllowedPath(rawPath) {
  if (!isBlockedPath(rawPath)) return;
  const resolved = path.resolve(process.cwd(), String(rawPath));
  const rel = path.relative(ROOT, resolved).replaceAll(path.sep, "/");
  throw new Error(`FACH_ACCESS_DENIED: ${rel}`);
}

function wrapMethod(target, methodName, pathIndexes) {
  const original = target[methodName];
  if (typeof original !== "function") {
    return () => {};
  }

  target[methodName] = function wrapped(...args) {
    for (const idx of pathIndexes) {
      assertAllowedPath(args[idx]);
    }
    return original.apply(this, args);
  };

  return () => {
    target[methodName] = original;
  };
}

function installFsGuard() {
  const restores = [];

  const promiseMethods = [
    ["access", [0]],
    ["appendFile", [0]],
    ["copyFile", [0, 1]],
    ["cp", [0, 1]],
    ["mkdir", [0]],
    ["open", [0]],
    ["readFile", [0]],
    ["readdir", [0]],
    ["rename", [0, 1]],
    ["rm", [0]],
    ["stat", [0]],
    ["writeFile", [0]],
  ];

  const syncMethods = [
    ["appendFileSync", [0]],
    ["copyFileSync", [0, 1]],
    ["mkdirSync", [0]],
    ["openSync", [0]],
    ["readFileSync", [0]],
    ["readdirSync", [0]],
    ["renameSync", [0, 1]],
    ["rmSync", [0]],
    ["statSync", [0]],
    ["writeFileSync", [0]],
    ["createReadStream", [0]],
    ["createWriteStream", [0]],
  ];

  for (const [method, indexes] of promiseMethods) {
    restores.push(wrapMethod(fsp, method, indexes));
  }
  for (const [method, indexes] of syncMethods) {
    restores.push(wrapMethod(fs, method, indexes));
  }

  return () => {
    for (const restore of restores.reverse()) {
      restore();
    }
  };
}

async function runWithFachFsGuard(fn) {
  const restore = installFsGuard();
  try {
    return await fn();
  } finally {
    restore();
  }
}

module.exports = {
  BLOCKED_DIRS,
  assertAllowedPath,
  runWithFachFsGuard,
};
