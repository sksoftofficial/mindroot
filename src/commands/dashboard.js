import { spawn } from "node:child_process";
import { DEFAULT_PORT, ensureConfig } from "../paths.js";

const CANDIDATES = {
  darwin: [
    ["open", "-a", "Google Chrome"],
    ["open", "-a", "Safari"],
    ["open"],
  ],
  linux: [
    ["google-chrome"],
    ["google-chrome-stable"],
    ["chromium"],
    ["chromium-browser"],
    ["firefox"],
    ["xdg-open"],
  ],
  win32: [
    ["cmd", "/c", "start", "chrome"],
    ["cmd", "/c", "start", "msedge"],
    ["cmd", "/c", "start"],
  ],
};

function tryOpen(cmd, url) {
  return new Promise((resolve) => {
    const child = spawn(cmd[0], [...cmd.slice(1), url], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function dashboard() {
  const { cfg } = ensureConfig();
  const port = cfg.port ?? DEFAULT_PORT;
  const url = `http://127.0.0.1:${port}/`;

  let healthy = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    healthy = res.ok;
  } catch {}
  if (!healthy) {
    console.error("mindroot is not running — run `mindroot start` first");
    process.exitCode = 1;
    return;
  }

  for (const cmd of CANDIDATES[process.platform] ?? []) {
    if (await tryOpen(cmd, url)) {
      console.log(`opening dashboard: ${url}`);
      return;
    }
  }
  console.error(`could not open a browser — visit ${url} manually`);
  process.exitCode = 1;
}
