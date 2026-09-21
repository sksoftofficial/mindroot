import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { configureOpencode, install } from "../src/commands/install.js";

let dir;
const cfg = { port: 8765, apiKey: "test-only-key" };
const policy = (await fs.readFile(new URL("../INSTRUCTIONS.md", import.meta.url), "utf8")).trim();
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "mindroot-install-")); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

test("creates global config and policy; a rerun is byte-identical", async () => {
  const configDir = path.join(dir, "opencode");
  const { configPath, agentsPath } = configureOpencode(cfg, configDir);
  const configText = await fs.readFile(configPath, "utf8");
  assert.deepEqual(JSON.parse(configText), {
    $schema: "https://opencode.ai/config.json",
    mcp: { mindroot: {
      type: "remote", url: "http://127.0.0.1:8765/mcp", enabled: true,
      headers: { Authorization: "Bearer test-only-key" },
    } },
  });
  assert.equal(await fs.readFile(agentsPath, "utf8"), policy + "\n");
  configureOpencode(cfg, configDir);
  assert.equal(await fs.readFile(configPath, "utf8"), configText);
  assert.equal(await fs.readFile(agentsPath, "utf8"), policy + "\n");
  if (process.platform !== "win32") assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600);
});

test("refreshes the owned MCP entry while preserving JSONC and unrelated settings", async () => {
  const jsonPath = path.join(dir, "opencode.json");
  const jsoncPath = path.join(dir, "opencode.jsonc");
  const json = '{"model":"keep/this"}\n';
  await fs.writeFile(jsonPath, json);
  await fs.writeFile(jsoncPath, `{
  // Keep this comment and setting.
  "model": "provider/model",
  "mcp": {
    // Another server stays untouched.
    "other": { "type": "local", "command": ["other-mcp"] },
    "mindroot": { "type": "local", "command": ["old"], "enabled": false },
  },
}\n`);
  const { configPath } = configureOpencode(cfg, dir);
  assert.equal(configPath, jsoncPath);
  assert.equal(await fs.readFile(jsonPath, "utf8"), json);
  const text = await fs.readFile(jsoncPath, "utf8");
  assert.ok(text.includes("// Keep this comment and setting."));
  assert.ok(text.includes('// Another server stays untouched.\n    "other": { "type": "local", "command": ["other-mcp"] },'));
  const config = parse(text);
  assert.equal(config.model, "provider/model");
  assert.equal(config.mcp.mindroot.command, undefined);
  assert.equal(config.mcp.mindroot.enabled, true);
  configureOpencode({ port: 9876, apiKey: "replacement-test-key" }, dir);
  const updated = parse(await fs.readFile(jsoncPath, "utf8")).mcp.mindroot;
  assert.equal(updated.url, "http://127.0.0.1:9876/mcp");
  assert.equal(updated.headers.Authorization, "Bearer replacement-test-key");
});

test("replaces marked policies, removes duplicates, and preserves surrounding instructions", async () => {
  const agentsPath = path.join(dir, "AGENTS.md");
  const old = "<!-- mindroot:start -->\nOld policy\n<!-- mindroot:end -->";
  const prefix = "# User instructions\nKeep these.\n\n";
  const middle = "\n\n<!-- another:start -->\nOther policy\n<!-- another:end -->\n";
  const suffix = "\nCustom footer without a trailing newline";
  await fs.writeFile(agentsPath, prefix + old + middle + old + suffix);
  configureOpencode(cfg, dir);
  const expected = prefix + policy + middle + suffix;
  assert.equal(await fs.readFile(agentsPath, "utf8"), expected);
  configureOpencode(cfg, dir);
  assert.equal(await fs.readFile(agentsPath, "utf8"), expected);
});

test("appends a separated policy when no marked block exists", async () => {
  const agentsPath = path.join(dir, "AGENTS.md");
  for (const existing of ["", "Keep me", "Keep me\n", "Keep me\n\n"]) {
    await fs.writeFile(agentsPath, existing);
    configureOpencode(cfg, dir);
    assert.equal(await fs.readFile(agentsPath, "utf8"), (existing ? "Keep me\n\n" : "") + policy + "\n");
  }
});

test("malformed config or markers leave both files untouched", async () => {
  const configPath = path.join(dir, "opencode.json");
  const agentsPath = path.join(dir, "AGENTS.md");
  const cases = [
    ["{ broken", "Keep me", /invalid OpenCode configuration/],
    ["[]", "Keep me", /invalid OpenCode configuration/],
    ['{"mcp": []}', "Keep me", /expected an mcp object/],
    ['{"mcp": null}', "Keep me", /expected an mcp object/],
    ["{}", "<!-- mindroot:start -->\nunfinished", /unbalanced mindroot markers/],
    ["{}", "<!-- mindroot:end -->", /unbalanced mindroot markers/],
    ["{}", "<!-- mindroot:start --><!-- mindroot:start --><!-- mindroot:end --><!-- mindroot:end -->", /unbalanced mindroot markers/],
  ];
  for (const [config, agents, error] of cases) {
    await fs.writeFile(configPath, config);
    await fs.writeFile(agentsPath, agents);
    assert.throws(() => configureOpencode(cfg, dir), error);
    assert.equal(await fs.readFile(configPath, "utf8"), config);
    assert.equal(await fs.readFile(agentsPath, "utf8"), agents);
  }
});

test("respects XDG_CONFIG_HOME and the explicit OpenCode directory override", (t) => {
  const previous = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.OPENCODE_CONFIG_DIR;
  assert.equal(configureOpencode(cfg).configPath, path.join(dir, "opencode", "opencode.json"));
  const custom = path.join(dir, "custom");
  process.env.OPENCODE_CONFIG_DIR = custom;
  assert.equal(configureOpencode(cfg).agentsPath, path.join(custom, "AGENTS.md"));
});

test("rejects missing or unsupported install targets before initialization", async () => {
  for (const args of [[], ["unknown"], ["opencode", "extra"], ["claude", "codex"]]) {
    await assert.rejects(install(args), /usage: mindroot install <opencode\|claude\|codex>/);
  }
});
