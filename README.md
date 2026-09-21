# Mindroot

AI agents that never forget.

![Mindroot persistent AI agent memory system](https://skbilisim.com/assets/projects/mindroot.webp)

Mindroot is a tiny Node.js service that gives your AI agents project-scoped hybrid-searched **memories** over human-editable markdown **notes**, and reusable **skills** for recurring work. It exposes a local HTTP service with an MCP interface, a REST API, and a built-in dashboard. Everything runs on your machine — offline embeddings, SQLite, plain markdown files you own. No cloud, no API keys, no per-query cost.

- Website: https://skbilisim.com/en/projects/mindroot
- npm: https://www.npmjs.com/package/@sksoftofficial/mindroot

## How it works

- **Notes** (Layer 2): human-editable markdown files under `~/.mindroot/notes/<project>/`, parsed into heading-addressable sections such as `Overview::API`. The unit of storage.
- **Memories** (Layer 1): short, retrieval-optimized texts that stand alone or point into a note or section via `target_path`. The unit of retrieval.
- **Search**: memories are the semantic index — hybrid ranking of cosine similarity (0.75) over local embeddings plus BM25 keyword search (0.25) through SQLite FTS5. Note sections use literal case-insensitive string matching. All content search is strictly project-scoped; project discovery uses its own fuzzy slug search with slug embeddings and token overlap.
- **Skills**: project-specific Markdown procedures stored in SQLite with stable names and revision history. Skill names and descriptions have their own hybrid search index; agents load the full instructions only when a match is relevant. Saving a skill indexes it automatically, without creating memories or embedding the full procedure.

## Features

- **Two-layer memory** — markdown notes for depth, short memories for recall, linked via heading paths.
- **Local embeddings** — 768-dimensional q8 embeddings from `onnx-community/embeddinggemma-300m-ONNX` via transformers.js, computed fully offline and cached under `~/.mindroot/models`.
- **Hybrid search** — semantic + BM25 ranking over memories, literal string matching over note sections, fuzzy project-name matching across projects.
- **Project skills** — agents discover and apply saved procedures, then automatically capture or improve verified procedures through the skills policy below.
- **MCP server** — JSON-RPC endpoint at `/mcp` with 16 project/memory/note/skill tools for agents.
- **REST API** — the same operations over `POST/GET/PUT/DELETE /api/*` for scripts and integrations.
- **Dashboard** — web UI at `/` for browsing notes, memories, and skills, editing Markdown, and inspecting skill revisions.
- **CLI** — init, start/stop/restart/status, and human-readable browsing commands.
- **Background service** — `mindroot start` daemonizes, writes a pidfile, and waits until healthy; `stop` and `restart` manage it.
- **Self-healing reads** — note reads verify a stored content hash and silently re-index files edited externally.
- **Surgical edits** — `update_section` splices only the targeted heading's line range, leaving the rest of the file byte-identical.
- **Link cleanup** — deleting a note clears memories linked to its exact path or one of its heading paths.
- **Auto-created projects** — any write to a new project slug creates it; no cwd detection, no disk scanning, no cross-project content search.
- **Local-first storage** — one SQLite database (`node:sqlite`, WAL mode, FTS5) plus plain markdown files you own.
- **Security** — constant-time Bearer API-key auth for every `/api` and `/mcp` request, server-side path-traversal and slug validation, localhost-only by default.

## Install

Requires Node.js >= 22.

```sh
npm install -g @sksoftofficial/mindroot   # or: npm link from a clone
mindroot init                              # creates store, schema, api key; caches the embedding model (~316MB)
mindroot start                             # daemonizes and waits until healthy
```

## Service management

```sh
mindroot start            # start in the background, wait for /health
mindroot start --foreground  # run attached for debugging
mindroot stop             # stop the pidfile process (escalates when needed)
mindroot restart          # stop + start
mindroot status           # pidfile, health endpoint, and key consistency check
mindroot dashboard        # open the dashboard in your browser
```

The default address is `127.0.0.1:7620`, configurable in `~/.mindroot/config.json`. There is no crash auto-restart.

## Quick start (MCP)

For OpenCode, Claude Code, or Codex, use the one-command setup instead of manually running `init` and `start`:

```sh
mindroot install opencode   # ~/.config/opencode
mindroot install claude     # ~/.claude.json + ~/.claude/CLAUDE.md
mindroot install codex      # ~/.codex/config.toml + ~/.codex/AGENTS.md
```

This initializes Mindroot (including the model cache), starts the background service if needed, and configures the client's global `mindroot` MCP entry with the local service URL and API key. It also installs the bundled `INSTRUCTIONS.md` policy into the client's global instructions file.

Rerunning refreshes the MCP entry and replaces the policy between `<!-- mindroot:start -->` and `<!-- mindroot:end -->`, rather than appending duplicates. Other MCP servers, configuration settings, comments, and instructions outside the marked blocks are preserved. Unbalanced policy markers or malformed configuration cause an error rather than an overwrite.

Default locations, honoring each client's directory override:

- OpenCode: `~/.config/opencode`, honoring `XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR`. An existing `opencode.jsonc` takes precedence; otherwise the command updates or creates `opencode.json`.
- Claude Code: `~/.claude.json` and `~/.claude/CLAUDE.md`, honoring `CLAUDE_CONFIG_DIR` (both files then live inside that directory).
- Codex: `~/.codex/config.toml` and `~/.codex/AGENTS.md`, honoring `CODEX_HOME`. A non-empty `AGENTS.override.md` takes precedence and is updated instead; an empty override falls back to `AGENTS.md`.

Quit and restart the client afterward to load the changes. The command configures the client; it does not launch it.

### Other MCP clients

Point your MCP client at the service:

```json
{
  "mcpServers": {
    "mindroot": {
      "type": "remote",
      "url": "http://127.0.0.1:7620/mcp",
      "headers": { "Authorization": "Bearer <apiKey>" }
    }
  }
}
```

The API key is generated by `mindroot init` and stored in `~/.mindroot/config.json` (never printed). Tool failures return `isError: true` content instead of crashing the call.

## Agent memory policy

Add this policy to your agent's instructions:

```markdown
<!-- mindroot:start -->
# Agent memory policy (mindroot)

Use mindroot MCP tools as persistent memory for durable facts about the user and each project. Keep it compact; it is not a scratchpad.

## Project memory

- Resolve the project once with `search_projects` or `list_projects` and reuse its slug.
- Call `search_memories` when starting a new task or investigating a new topic, then `read_note` the relevant linked notes. Reuse notes already in context; repeat lookups only when more information or refreshed context is needed.
- Consult memory before exploring source. If relevant notes are missing or contradict reality, inspect source and correct stale notes.
- Project content tools need a project slug. A project is created automatically on first write.

## Notes vs memories

Notes are storage; memories are the retrieval index into them. They work as a pair:

- **Memories** (`save_memory`, `delete_memory`) — short, standalone atomic facts ("where email delivery lives", "never migrate during business hours"), optionally linked via `target_path` ("note.md::Heading"). The semantic search layer: `search_memories` ranks hybrid (embeddings + keywords). No listing tool; hits carry the ids for `delete_memory`. When in doubt, save a memory.
- **Notes** (`save_note`, `update_section`, `read_note`, `delete_note`) — structured markdown docs parsed into heading-addressable sections. `read_note` without args returns full content plus the section list; with `section` ("Audit logging::API") returns only that section's body — prefer section reads when you don't need the whole note. `update_section` takes the same heading paths; run `read_note`/`list_notes` first and copy exact paths. `search_notes` is a literal case-insensitive string search over section text — a fallback for exact keywords/identifiers, not semantic search.

After writing or updating a notable note section, also save 1–3 memories pointing at it (`target_path`) so future searches surface it — one per key fact a future agent would search for. If a memory stands alone (no note worth writing), that's fine too. Dedupe by searching first, then deleting stale hits — never stack near-copies.

Notes read like compact index cards: one sentence on what the feature is, then the files, entry points, and data flow needed to work on it later — enough to answer "where is this implemented?" without reading source. Keep one feature per note under keyword-rich headings (`## Model`, `## API`, `## Gotchas`, …), plus standard cross-cutting notes: `overview.md`, `conventions.md` (patterns shared across features), `commands.md`, `gotchas.md`.

## What to save

Facts that improve future navigation, implementation, debugging, or verification: structure and key files, config values, frameworks/services, build/test/deploy commands, conventions, recurring bugs and gotchas.

Never save: task history, reasoning trails, rejected alternatives, dated recaps, secrets, logs, or speculation.

Write bullets as standalone present-tense facts with file anchors (`models/AuditLog.jsx` defines model `AuditLog` in collection `auditlog`). Not "we decided X today".

After work that changes a durable fact, update the smallest relevant note section — plus linked memories for its key facts — automatically before your final response, no confirmation needed. Notes stay compact: merge overlapping bullets, drop stale ones.

## Project skills

Skills store reusable procedures for recurring work in this project: notes and memories hold facts, skills hold how to do a task.

- Call `search_skills` once before a non-trivial multi-step task; skip simple edits, straightforward questions, and work already clear from context. Reuse skills already loaded; if nothing fits, proceed normally.
- After finishing a verified multi-step procedure that is not already captured, save or improve its skill automatically before responding — the reusable procedure, not a task recap, an issue-specific fix, or an unverified approach.
- Structure content as **When to use**, **Prerequisites**, **Procedure**, **Success criteria**, and **Pitfalls**; reference notes or source instead of duplicating facts, and correct skills that no longer match project behavior.
<!-- mindroot:end -->
```

## Using skills

Automatic skill management is driven by the agent policy: the agent searches once before starting non-trivial work and captures verified procedures after finishing it. Mindroot stores and retrieves procedures; it does not watch conversations or execute skills itself. Copy the policy above (also available in `INSTRUCTIONS.md`) into your agent's instructions.

For example, an agent can create a skill with `save_skill`:

```json
{
  "project": "my-project",
  "name": "add-api-route",
  "description": "Use when adding an API route with the project's existing handler and error conventions.",
  "content": "## When to use\nAdding an API route.\n\n## Prerequisites\nRead conventions.md::API and identify the existing router.\n\n## Procedure\n1. Follow a neighboring handler's registration and error handling.\n2. Implement the requested behavior.\n3. Update the API documentation.\n\n## Success criteria\nThe route is registered and satisfies the requested behavior; follow the task's authorized validation requirements.\n\n## Pitfalls\nDo not copy credentials or request-specific data into examples.",
  "expected_revision": 0
}
```

When a saved procedure would help with a later API task, call `search_skills` with `{ "project": "my-project", "query": "add an API endpoint" }`, then `read_skill` with a relevant returned name. Search returns only names, descriptions, revisions, timestamps, and scores.

To improve a skill, read its latest version and save under the same name with that `expected_revision`. Each changed save preserves a revision; identical saves are a no-op. A stale or concurrent save returns a conflict so the agent can reread and reconcile. Use `read_skill` with `revision` to inspect an older version; to restore it, save that content using the latest revision as `expected_revision`. Deleting a skill removes all its revisions and index entries.

Skills are available through MCP, REST, and the dashboard. The dashboard lists saved skills and supports reading, editing, viewing revision history, and deletion. CLI content commands cover notes and memories. After updating an existing installation, restart mindroot to create the skill tables and reconnect your MCP client to refresh its tool list.

## CLI

CLI output is human-readable; agents should use MCP tools.

| Command | Description |
|---|---|
| `mindroot init` | Initialize store + model cache (idempotent) |
| `mindroot install <opencode\|claude\|codex>` | Initialize, start, and configure a coding agent globally |
| `mindroot start [--foreground]` | Daemonize the service (or run foreground for debugging) |
| `mindroot stop` | Stop the running service |
| `mindroot restart` | Restart the service (stop + start) |
| `mindroot status` | Show whether the service is running |
| `mindroot dashboard` | Open the dashboard in your browser |
| `mindroot projects` | List projects with counts |
| `mindroot notes --project <slug> [path]` | List notes, or print one |
| `mindroot memories --project <slug>` | List memories |
| `mindroot save-memory "<text>" --project <slug> [--link "note.md::Heading"]` | Save a memory |
| `mindroot search "<query>" --project <slug> [--limit N]` | Search memories + notes |

## MCP tools

Tool names on the wire are unprefixed; MCP clients may display them with a `mindroot_` prefix.

| Tool | Params | Purpose |
|---|---|---|
| `list_projects` | — | List projects with note/memory/skill counts |
| `search_projects` | `query` | Fuzzy-find a project by name (semantic + token overlap) |
| `rename_project` | `project*`, `new_slug*` | Rename a project; moves notes and preserves memories and indexes |
| `search_memories` | `project*`, `query`, `limit?` | Hybrid search over memories (hits carry ids) |
| `search_notes` | `project*`, `query`, `limit?` | Literal string search over note sections (fallback to memories' semantic search) |
| `save_memory` | `project*`, `text`, `target_path?` | Save a memory, optionally linked to a note/section |
| `delete_memory` | `project*`, `id` | Delete a memory by id |
| `list_notes` | `project*` | List notes with section paths |
| `read_note` | `project*`, `path`, `section?` | Full note content, or one section's body via `section` (hash-verified, auto-reindexed) |
| `save_note` | `project*`, `path`, `content` | Create/overwrite a note |
| `update_section` | `project*`, `path`, `heading_path`, `content` | Replace one section body, or append the section when missing |
| `delete_note` | `project*`, `path` | Delete a note (clears its linked memories) |
| `search_skills` | `project*`, `query`, `limit?` | Hybrid search over skill names and descriptions; returns summaries |
| `read_skill` | `project*`, `name`, `revision?` | Read current instructions or a historical revision |
| `save_skill` | `project*`, `name`, `description`, `content`, `expected_revision?` | Create/update and index a skill; preserve history; use revision 0 for create-only |
| `delete_skill` | `project*`, `name` | Delete a skill, its history, and its index |

## REST API

Same operations as MCP, for scripts and integrations. All `/api/*` routes (and `/mcp`) require `Authorization: Bearer <apiKey>`; `/health` does not.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe |
| `GET` | `/api/projects` | List projects |
| `POST` | `/api/projects` | Create project `{ slug }` |
| `GET` | `/api/projects/:slug` | Project detail with docs, memories, and skill summaries |
| `DELETE` | `/api/projects/:slug` | Delete a project |
| `GET` | `/api/projects/:slug/docs` | List notes |
| `GET/PUT/DELETE` | `/api/projects/:slug/doc?path=` | Read (optionally `&section=`), write, or delete one note |
| `POST` | `/api/projects/:slug/sections` | Update one section `{ path, heading_path, content }` |
| `GET/POST` | `/api/projects/:slug/memories` | List or add memories `{ text, target_path? }` |
| `DELETE` | `/api/projects/:slug/memories/:id` | Delete a memory |
| `GET` | `/api/projects/:slug/skills` | List skill summaries |
| `GET/PUT/DELETE` | `/api/projects/:slug/skills/:name` | Read (`?revision=` optional), save `{ description, content, expected_revision? }`, or delete a skill |
| `POST` | `/api/search` | Search `{ project, query, kind?: "memories"\|"notes"\|"skills", limit? }`; omit `kind` for memories + notes |
| `POST` | `/mcp` | JSON-RPC MCP endpoint |

## Dashboard

The dashboard at `http://127.0.0.1:7620/` stores its key in localStorage and offers:

- **Notes** view with a markdown editor in Write / Split / Read modes and rendered preview.
- **Memories** view for browsing saved memories, following note links, and deleting entries.
- **Skills** view for browsing saved procedures, editing descriptions and Markdown in Write / Split / Read modes, inspecting older revisions, and deleting skills. Saves detect conflicting updates and preserve your draft on failure; historical revisions are read-only.

Memory creation and search are available through MCP and REST; the dashboard has no add-memory form or Search tab.

## Configuration

Everything lives under `~/.mindroot/`:

- `config.json` — `port` (default 7620) and `apiKey`
- `notes/<project>/` — your markdown notes
- `models/` — cached ONNX embedding model
- `mindroot.db` — SQLite index, skill Markdown content, and skill revisions (WAL mode)
- `mindroot.pid` / `mindroot.log` — written by `start`/`stop`

Set `MINDROOT_DIR` to relocate the whole store.

## Development

```sh
node --test    # runs the test suite in test/
```

## License

ISC
