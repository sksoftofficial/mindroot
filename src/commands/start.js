import fsSync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, MINDROOT_DIR, ensureConfig } from "../paths.js";
import { open } from "../store/db.js";
import { createServer } from "../server.js";

const BIN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "mindroot.js",
);
const PID_FILE = path.join(MINDROOT_DIR, "mindroot.pid");
const LOG_FILE = path.join(MINDROOT_DIR, "mindroot.log");

function readPid() {
  try {
    return Number(fsSync.readFileSync(PID_FILE, "utf8").trim());
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await healthy(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export function isRunning(cfg) {
  const pid = readPid();
  return pid !== null && pidAlive(pid) ? pid : null;
}

export async function start(argv = []) {
  const { cfg } = ensureConfig();

  if (argv.includes("--foreground")) {
    return runForeground(cfg);
  }

  const existing = isRunning(cfg);
  if (existing) {
    console.log(`mindroot already running (pid ${existing})`);
    return;
  }

  fsSync.mkdirSync(MINDROOT_DIR, { recursive: true });
  const out = fsSync.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [BIN_PATH, "start", "--foreground"], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  fsSync.writeFileSync(PID_FILE, String(child.pid));

  console.log(`starting mindroot on http://127.0.0.1:${cfg.port} ...`);
  if (await waitFor(cfg.port, 15000) && pidAlive(child.pid)) {
    console.log(`started (pid ${child.pid})`);
    console.log(`dashboard: http://127.0.0.1:${cfg.port}/`);
    console.log(`logs: ${LOG_FILE}`);
    console.log(`stop: mindroot stop`);
  } else {
    console.error(`failed to start — last log lines:`);
    try {
      const log = fsSync.readFileSync(LOG_FILE, "utf8").trimEnd();
      console.error(log.split("\n").slice(-10).join("\n"));
    } catch {}
    try { fsSync.unlinkSync(PID_FILE); } catch {}
    process.exitCode = 1;
  }
}

function runForeground(cfg) {
  fsSync.writeFileSync(PID_FILE, String(process.pid));
  const db = open();
  const server = createServer(db, cfg);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${cfg.port} is already in use — is mindroot already running? (port config: ${MINDROOT_DIR}/config.json)`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(cfg.port, "127.0.0.1", () => {
    console.log(`mindroot listening on http://127.0.0.1:${cfg.port}`);
    console.log(`press Ctrl+C to stop`);
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
    try { fsSync.unlinkSync(PID_FILE); } catch {}
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function restart() {
  const pid = readPid();
  if (pid !== null && pidAlive(pid)) {
    await stop();
  } else {
    try { fsSync.unlinkSync(PID_FILE); } catch {}
  }
  return start();
}

export async function stop() {
  const pid = readPid();
  if (pid === null || !pidAlive(pid)) {
    try { fsSync.unlinkSync(PID_FILE); } catch {}
    console.log("mindroot is not running");
    return;
  }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 30 && pidAlive(pid); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
  try { fsSync.unlinkSync(PID_FILE); } catch {}
  console.log(`stopped (pid ${pid})`);
}

export async function status() {
  const { cfg } = ensureConfig();
  const pid = isRunning(cfg);
  if (pid === null) {
    console.log("mindroot is not running");
    return;
  }
  const port = cfg.port ?? DEFAULT_PORT;
  const ok = await healthy(port);
  let auth = "unknown";
  if (ok) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(2000),
      });
      auth = res.ok ? "key ok" : "KEY MISMATCH — update your MCP client's Bearer key from ~/.mindroot/config.json";
    } catch {
      auth = "check failed";
    }
  }
  console.log(`mindroot is running (pid ${pid}, http://127.0.0.1:${port}, health: ${ok ? "ok" : "unreachable"}, auth: ${auth})`);
}
