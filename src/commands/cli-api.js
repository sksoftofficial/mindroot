import { loadConfig } from "../paths.js";

function base() {
  const cfg = loadConfig();
  return `http://127.0.0.1:${cfg.port ?? 7620}`;
}

export async function api(method, pathname, body) {
  let res;
  try {
    res = await fetch(base() + pathname, {
      method,
      headers: {
        authorization: `Bearer ${loadConfig().apiKey ?? ""}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED") {
      throw new Error("mindroot service is not running — start it with: mindroot service");
    }
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}
