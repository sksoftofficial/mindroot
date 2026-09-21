import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse, modify, applyEdits } from "jsonc-parser";
import { parse as parseToml, patch as patchToml } from "@decimalturn/toml-patch";
import { ensureConfig } from "../paths.js";
import { init } from "./init.js";
import { start } from "./start.js";

function readPolicy() {
  return fs.readFileSync(new URL("../../INSTRUCTIONS.md", import.meta.url), "utf8").trim();
}

function syncPolicy(agents, agentsPath) {
  const policy = readPolicy();
  const markers = [...agents.matchAll(/<!-- mindroot:(start|end) -->/g)];
  if (markers.length % 2 || markers.some((marker, i) => marker[1] !== (i % 2 ? "end" : "start"))) {
    throw new Error(`unbalanced mindroot markers in ${agentsPath}; fix them before rerunning`);
  }
  let replaced = false;
  let updated = agents.replace(/<!-- mindroot:start -->[\s\S]*?<!-- mindroot:end -->/g, () => {
    if (replaced) return "";
    replaced = true;
    return policy;
  });
  if (!replaced) {
    const separator = !agents || agents.endsWith("\n\n") ? "" : agents.endsWith("\n") ? "\n" : "\n\n";
    updated = agents + separator + policy + "\n";
  }
  return updated;
}

function mcpEntry(cfg) {
  return {
    url: `http://127.0.0.1:${cfg.port}/mcp`,
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function writeBoth(configPath, originalConfig, updatedConfig, agentsPath, agents, updatedAgents) {
  // Validate both files before writing either.
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  if (updatedConfig !== originalConfig) fs.writeFileSync(configPath, updatedConfig, { mode: 0o600 });
  if (updatedAgents !== agents) fs.writeFileSync(agentsPath, updatedAgents);
  return { configPath, agentsPath };
}

export function configureOpencode(cfg, configDir) {
  const xdg = process.env.XDG_CONFIG_HOME;
  configDir ??= process.env.OPENCODE_CONFIG_DIR || path.join(
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config"), "opencode",
  );
  const jsoncPath = path.join(configDir, "opencode.jsonc");
  const configPath = fs.existsSync(jsoncPath) ? jsoncPath : path.join(configDir, "opencode.json");
  const agentsPath = path.join(configDir, "AGENTS.md");
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}\n";
  const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  const errors = [];
  const config = parse(originalConfig, errors, { allowTrailingComma: true });
  if (errors.length || !isObject(config)) {
    throw new Error(`invalid OpenCode configuration: ${configPath}; fix it before rerunning`);
  }
  if (config.mcp !== undefined && !isObject(config.mcp)) {
    throw new Error(`expected an mcp object in ${configPath}; fix it before rerunning`);
  }

  const indent = originalConfig.match(/\n([ \t]+)\S/)?.[1] ?? "  ";
  const options = { formattingOptions: {
    insertSpaces: !indent.includes("\t"), tabSize: indent.length,
    eol: originalConfig.includes("\r\n") ? "\r\n" : "\n",
  } };
  let updatedConfig = originalConfig;
  if (config.$schema === undefined) {
    updatedConfig = applyEdits(updatedConfig, modify(updatedConfig, ["$schema"], "https://opencode.ai/config.json", options));
  }
  updatedConfig = applyEdits(updatedConfig, modify(updatedConfig, ["mcp", "mindroot"], {
    type: "remote",
    ...mcpEntry(cfg),
    enabled: true,
  }, options));
  const updatedAgents = syncPolicy(agents, agentsPath);

  return writeBoth(configPath, originalConfig, updatedConfig, agentsPath, agents, updatedAgents);
}

export function configureClaude(cfg, configDir) {
  const override = configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const home = os.homedir();
  // Without CLAUDE_CONFIG_DIR, the config file lives outside the instructions directory.
  const configPath = override ? path.join(override, ".claude.json") : path.join(home, ".claude.json");
  const agentsPath = override ? path.join(override, "CLAUDE.md") : path.join(home, ".claude", "CLAUDE.md");
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}\n";
  const agents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  let config;
  try {
    config = JSON.parse(originalConfig);
  } catch {
    throw new Error(`invalid Claude configuration: ${configPath}; fix it before rerunning`);
  }
  if (!isObject(config)) {
    throw new Error(`invalid Claude configuration: ${configPath}; fix it before rerunning`);
  }
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) {
    throw new Error(`expected an mcpServers object in ${configPath}; fix it before rerunning`);
  }

  const updatedConfig = JSON.stringify({
    ...config,
    mcpServers: {
      ...config.mcpServers,
      mindroot: { type: "http", ...mcpEntry(cfg) },
    },
  }, null, 2) + "\n";
  const updatedAgents = syncPolicy(agents, agentsPath);

  return writeBoth(configPath, originalConfig, updatedConfig, agentsPath, agents, updatedAgents);
}

export function configureCodex(cfg, configDir) {
  configDir ??= process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const configPath = path.join(configDir, "config.toml");
  const basePath = path.join(configDir, "AGENTS.md");
  const overridePath = path.join(configDir, "AGENTS.override.md");
  const originalConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  let config;
  try {
    config = parseToml(originalConfig);
  } catch {
    throw new Error(`invalid Codex configuration: ${configPath}; fix it before rerunning`);
  }
  if (config.mcp_servers !== undefined && !isObject(config.mcp_servers)) {
    throw new Error(`expected an mcp_servers table in ${configPath}; fix it before rerunning`);
  }
  if (config.mcp_servers?.mindroot !== undefined && !isObject(config.mcp_servers.mindroot)) {
    throw new Error(`expected mcp_servers.mindroot to be a table in ${configPath}; fix it before rerunning`);
  }

  // A non-empty AGENTS.override.md hides AGENTS.md entirely, so sync it instead.
  let agentsPath = basePath;
  let agents;
  if (fs.existsSync(overridePath)) {
    const override = fs.readFileSync(overridePath, "utf8");
    if (override.trim()) {
      agentsPath = overridePath;
      agents = override;
    }
  }
  agents ??= fs.existsSync(basePath) ? fs.readFileSync(basePath, "utf8") : "";

  const updatedConfig = patchToml(originalConfig, {
    mcp_servers: {
      ...config.mcp_servers,
      mindroot: {
        url: `http://127.0.0.1:${cfg.port}/mcp`,
        http_headers: { Authorization: `Bearer ${cfg.apiKey}` },
      },
    },
  });
  const updatedAgents = syncPolicy(agents, agentsPath);

  return writeBoth(configPath, originalConfig, updatedConfig, agentsPath, agents, updatedAgents);
}

const TARGETS = {
  opencode: {
    label: "OpenCode",
    configure: configureOpencode,
    hint: "Quit and restart OpenCode to load the updated configuration and instructions.",
  },
  claude: {
    label: "Claude Code",
    configure: configureClaude,
    hint: "Start a new Claude Code session to load the updated configuration and instructions.",
  },
  codex: {
    label: "Codex",
    configure: configureCodex,
    hint: "Start a new Codex session to load the updated configuration and instructions.",
  },
};

export async function install(argv = []) {
  const target = argv.length === 1 ? TARGETS[argv[0]] : undefined;
  if (!target) {
    throw new Error("usage: mindroot install <opencode|claude|codex>");
  }
  await init();
  await start();
  if (process.exitCode) return;

  const { cfg } = ensureConfig();
  const response = await fetch(`http://127.0.0.1:${cfg.port}/api/projects`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error("mindroot is not ready with the configured API key; run mindroot restart and retry");
  }
  await response.body?.cancel();

  const { configPath, agentsPath } = target.configure(cfg);
  console.log(`${target.label} MCP configured: ${configPath}`);
  console.log(`Mindroot instructions synced: ${agentsPath}`);
  console.log(target.hint);
}
