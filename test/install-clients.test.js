import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "@decimalturn/toml-patch";
import { configureClaude, configureCodex } from "../src/commands/install.js";

let dir;
const cfg = { port: 8765, apiKey: "test-only-key" };
const policy = (await fs.readFile(new URL("../INSTRUCTIONS.md", import.meta.url), "utf8")).trim();
const savedEnv = {};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mindroot-install-clients-"));
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
});

test("claude: defaults keep .claude.json outside ~/.claude; a rerun is byte-identical", async (t) => {
  const home = path.join(dir, "home");
  t.mock.method(os, "homedir", () => home);
  const { configPath, agentsPath } = configureClaude(cfg);
  assert.equal(configPath, path.join(home, ".claude.json"));
  assert.equal(agentsPath, path.join(home, ".claude", "CLAUDE.md"));
  const configText = await fs.readFile(configPath, "utf8");
  assert.deepEqual(JSON.parse(configText), {
    mcpServers: { mindroot: {
      type: "http", url: "http://127.0.0.1:8765/mcp",
      headers: { Authorization: "Bearer test-only-key" },
    } },
  });
  assert.equal(await fs.readFile(agentsPath, "utf8"), policy + "\n");
  configureClaude(cfg);
  assert.equal(await fs.readFile(configPath, "utf8"), configText);
  assert.equal(await fs.readFile(agentsPath, "utf8"), policy + "\n");
  if (process.platform !== "win32") assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test("claude: explicit directories and CLAUDE_CONFIG_DIR keep both files inside", async () => {
  const explicit = configureClaude(cfg, path.join(dir, "explicit"));
  assert.equal(explicit.configPath, path.join(dir, "explicit", ".claude.json"));
  assert.equal(explicit.agentsPath, path.join(dir, "explicit", "CLAUDE.md"));
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "envdir");
  const env = configureClaude(cfg);
  assert.equal(env.configPath, path.join(dir, "envdir", ".claude.json"));
  assert.equal(env.agentsPath, path.join(dir, "envdir", "CLAUDE.md"));
});

test("claude: preserves unrelated settings and refreshes the owned entry", async () => {
  const configPath = path.join(dir, ".claude.json");
  await fs.writeFile(configPath, JSON.stringify({
    model: "claude-opus",
    mcpServers: { other: { type: "stdio", command: ["x"] }, mindroot: { type: "sse", url: "stale" } },
    projects: { "/work": { allowed: true } },
  }));
  configureClaude(cfg, dir);
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(config.model, "claude-opus");
  assert.deepEqual(config.projects, { "/work": { allowed: true } });
  assert.deepEqual(config.mcpServers.other, { type: "stdio", command: ["x"] });
  assert.deepEqual(config.mcpServers.mindroot, {
    type: "http", url: "http://127.0.0.1:8765/mcp",
    headers: { Authorization: "Bearer test-only-key" },
  });
  configureClaude({ port: 9876, apiKey: "replacement-test-key" }, dir);
  const updated = JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers.mindroot;
  assert.equal(updated.url, "http://127.0.0.1:9876/mcp");
  assert.equal(updated.headers.Authorization, "Bearer replacement-test-key");
});

test("claude: malformed config or markers leave both files untouched", async () => {
  const configPath = path.join(dir, ".claude.json");
  const agentsPath = path.join(dir, "CLAUDE.md");
  const cases = [
    ["{ broken", "Keep me", /invalid Claude configuration/],
    ["[1]", "Keep me", /invalid Claude configuration/],
    ['{"mcpServers": []}', "Keep me", /expected an mcpServers object/],
    ["{}", "<!-- mindroot:start -->\nunfinished", /unbalanced mindroot markers/],
  ];
  for (const [config, agents, error] of cases) {
    await fs.writeFile(configPath, config);
    await fs.writeFile(agentsPath, agents);
    assert.throws(() => configureClaude(cfg, dir), error);
    assert.equal(await fs.readFile(configPath, "utf8"), config);
    assert.equal(await fs.readFile(agentsPath, "utf8"), agents);
  }
});

test("codex: creates config and policy, preserves TOML comments; a rerun is byte-identical", async () => {
  const configPath = path.join(dir, "config.toml");
  await fs.writeFile(configPath, `# Codex config
model = "gpt-5-codex"

[mcp_servers.other]
url = "https://example.com/mcp" # keep me
`);
  const { configPath: returned, agentsPath } = configureCodex(cfg, dir);
  assert.equal(returned, configPath);
  assert.equal(agentsPath, path.join(dir, "AGENTS.md"));
  const first = await fs.readFile(configPath, "utf8");
  assert.ok(first.includes("# Codex config"));
  assert.ok(first.includes('model = "gpt-5-codex"'));
  assert.ok(first.includes('url = "https://example.com/mcp" # keep me'));
  const config = parseToml(first);
  assert.deepEqual(config.mcp_servers.mindroot, {
    url: "http://127.0.0.1:8765/mcp",
    http_headers: { Authorization: "Bearer test-only-key" },
  });
  assert.equal(config.model, "gpt-5-codex");
  assert.equal(await fs.readFile(agentsPath, "utf8"), policy + "\n");
  configureCodex(cfg, dir);
  assert.equal(await fs.readFile(configPath, "utf8"), first);
  assert.equal(await fs.readFile(agentsPath, "utf8"), policy + "\n");
  if (process.platform !== "win32") assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test("codex: honors CODEX_HOME or ~/.codex by default and refreshes the owned entry", async (t) => {
  const home = path.join(dir, "home");
  t.mock.method(os, "homedir", () => home);
  const defaulted = configureCodex(cfg);
  assert.equal(defaulted.configPath, path.join(home, ".codex", "config.toml"));
  assert.equal(defaulted.agentsPath, path.join(home, ".codex", "AGENTS.md"));
  process.env.CODEX_HOME = path.join(dir, "custom");
  const env = configureCodex({ port: 9876, apiKey: "replacement-test-key" });
  assert.equal(env.configPath, path.join(dir, "custom", "config.toml"));
  const config = parseToml(await fs.readFile(env.configPath, "utf8"));
  assert.equal(config.mcp_servers.mindroot.url, "http://127.0.0.1:9876/mcp");
  assert.equal(config.mcp_servers.mindroot.http_headers.Authorization, "Bearer replacement-test-key");
});

test("codex: syncs a non-empty AGENTS.override.md; an empty override falls back to AGENTS.md", async () => {
  const basePath = path.join(dir, "AGENTS.md");
  const overridePath = path.join(dir, "AGENTS.override.md");
  await fs.writeFile(basePath, "# Base\nKeep me.\n");
  await fs.writeFile(overridePath, "Override content.\n");
  const active = configureCodex(cfg, dir);
  assert.equal(active.agentsPath, overridePath);
  assert.equal(await fs.readFile(overridePath, "utf8"), "Override content.\n\n" + policy + "\n");
  assert.equal(await fs.readFile(basePath, "utf8"), "# Base\nKeep me.\n");

  await fs.writeFile(overridePath, "\n");
  const fallback = configureCodex(cfg, dir);
  assert.equal(fallback.agentsPath, basePath);
  assert.equal(await fs.readFile(overridePath, "utf8"), "\n");
  assert.equal(await fs.readFile(basePath, "utf8"), "# Base\nKeep me.\n\n" + policy + "\n");
});

test("codex: malformed TOML, bad shapes, or markers leave both files untouched", async () => {
  const configPath = path.join(dir, "config.toml");
  const agentsPath = path.join(dir, "AGENTS.md");
  const cases = [
    ["model = ", "Keep me", /invalid Codex configuration/],
    ["mcp_servers = 3", "Keep me", /expected an mcp_servers table/],
    ["mcp_servers.mindroot = 5", "Keep me", /expected mcp_servers\.mindroot to be a table/],
    ["", "<!-- mindroot:end -->", /unbalanced mindroot markers/],
  ];
  for (const [config, agents, error] of cases) {
    await fs.writeFile(configPath, config);
    await fs.writeFile(agentsPath, agents);
    assert.throws(() => configureCodex(cfg, dir), error);
    assert.equal(await fs.readFile(configPath, "utf8"), config);
    assert.equal(await fs.readFile(agentsPath, "utf8"), agents);
  }
});

test("both clients replace marked policies and preserve surrounding instructions", async () => {
  const prefix = "# User instructions\nKeep these.\n\n";
  const suffix = "\nCustom footer without a trailing newline";
  const old = "<!-- mindroot:start -->\nOld policy\n<!-- mindroot:end -->";
  for (const configure of [(d) => configureClaude(cfg, d), (d) => configureCodex(cfg, d)]) {
    const agentsPath = path.join(dir, "AGENTS.md");
    await fs.writeFile(agentsPath, prefix + old + suffix);
    configure(dir);
    assert.equal(await fs.readFile(agentsPath, "utf8"), prefix + policy + suffix);
  }
});
