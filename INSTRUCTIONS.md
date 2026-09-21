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
