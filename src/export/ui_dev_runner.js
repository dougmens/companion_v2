const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { ROOT } = require("../lib/config");
const { pathExists } = require("../lib/fsx");
const { buildUi } = require("./ui_build_runner");

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function startFallbackServer({ root = ROOT, host = "127.0.0.1", port = 5173 } = {}) {
  const uiRoot = path.join(root, "ui");
  const dist = path.join(uiRoot, "dist");

  if (!(await pathExists(path.join(dist, "index.html")))) {
    await buildUi({ root });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const abs = path.resolve(path.join(dist, rel));
      if (!abs.startsWith(dist + path.sep) && abs !== path.join(dist, "index.html")) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid path");
        return;
      }

      const file = (await pathExists(abs)) ? abs : path.join(dist, "index.html");
      const data = await fs.readFile(file);
      res.writeHead(200, {
        "Content-Type": contentType(file),
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(error?.message || error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : port;
  // eslint-disable-next-line no-console
  console.log(`[ui:dev] fallback server running at http://${host}:${actualPort}`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function startUiDev({ root = ROOT } = {}) {
  const uiRoot = path.join(root, "ui");
  const viteBin = path.join(uiRoot, "node_modules", "vite", "bin", "vite.js");
  const host = process.env.UI_HOST || "127.0.0.1";
  const port = Number(process.env.UI_PORT || 5173);

  if (await pathExists(viteBin)) {
    const cp = spawn(process.execPath, [viteBin, "dev", "--host", host, "--port", String(port)], {
      cwd: uiRoot,
      stdio: "inherit",
    });
    cp.on("close", (code) => process.exit(code || 0));
    return;
  }

  try {
    await startFallbackServer({ root, host, port });
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      await buildUi({ root });
      const dist = path.join(root, "ui", "dist");
      const indexPath = path.join(dist, "index.html");
      const snapshotPath = path.join(dist, "dashboard_state.json");
      const indexRaw = await fs.readFile(indexPath, "utf8");
      const snapshotRaw = await fs.readFile(snapshotPath, "utf8");
      const snapshot = JSON.parse(snapshotRaw);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        ok: true,
        mode: "sandbox-smoke",
        reason: "socket_bind_not_permitted",
        index_ok: indexRaw.includes("Companion Runtime Dashboard"),
        snapshot_ok: typeof snapshot === "object" && snapshot !== null,
        snapshot_keys: Object.keys(snapshot || {}),
      }, null, 2));
      return;
    }
    throw error;
  }
}

if (require.main === module) {
  startUiDev().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error?.stack || error);
    process.exit(1);
  });
}

module.exports = {
  startUiDev,
};
