#!/usr/bin/env node

import { init } from "../src/commands/init.js";
import { start, stop, restart, status } from "../src/commands/start.js";
import { projects, searchCmd, saveMemoryCmd, memoriesCmd, notesCmd } from "../src/commands/human.js";
import { dashboard } from "../src/commands/dashboard.js";
import { install } from "../src/commands/install.js";

const [command, ...rest] = process.argv.slice(2);

const usage = `mindroot — persistent memory for AI agents

Usage:
  mindroot init                          Initialize store and download model
  mindroot install <opencode|claude|codex>  Initialize, start, and configure a coding agent globally
  mindroot start [--foreground]          Start the service in the background (or foreground)
  mindroot stop                          Stop the running service
  mindroot restart                       Restart the service (stop + start)
  mindroot status                        Show whether the service is running
  mindroot dashboard                     Open the dashboard in your browser
  mindroot projects                      List projects
  mindroot notes --project <slug> [path] List notes (or show one)
  mindroot memories --project <slug>     List memories
  mindroot save-memory <text> --project <slug> [--link "note.md::Heading"]
  mindroot search "query" --project <slug> [--limit N]
`;

async function main() {
  switch (command) {
    case undefined:
    case "--help":
    case "-h":
    case "help":
      return console.log(usage);
    case "init":
      return init();
    case "install":
      return install(rest);
    case "start":
      return start(rest);
    case "stop":
      return stop();
    case "restart":
      return restart();
    case "status":
      return status();
    case "dashboard":
      return dashboard();
    case "projects":
      return projects();
    case "notes":
      return notesCmd(rest);
    case "memories":
      return memoriesCmd(rest);
    case "save-memory":
      return saveMemoryCmd(rest);
    case "search":
      return searchCmd(rest);
    default:
      console.log(`unknown command: ${command}\n\n${usage}`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`error: ${err.message ?? err}`);
  process.exit(1);
});
