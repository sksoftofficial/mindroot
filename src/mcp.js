const SERVER_INFO = { name: "mindroot", version: "0.2.0" };
const PROTOCOL_VERSION = "2025-06-18";

export function tools() {
  return [
    {
      name: "list_projects",
      description: "List all projects known to mindroot with their note, memory, and skill counts. Use to discover valid project slugs before calling project-scoped tools.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_projects",
      description:
        "Find projects by fuzzy name. Matches project slugs semantically and by token overlap (e.g. 'mem-agent-mcp' finds 'proper-agent-memory'). Use to discover the right project slug before calling project-scoped tools.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Project name, full or partial/fuzzy" } },
        required: ["query"],
      },
    },
    {
      name: "rename_project",
      description:
        "Rename a project by slug. Moves its notes directory and updates the slug; notes, memories, and search indexes are preserved under the internal project id. The fuzzy-search vector for the new slug is rebuilt automatically on the next project search.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Current project slug" },
          new_slug: { type: "string", description: "New project slug" },
        },
        required: ["project", "new_slug"],
      },
    },
    {
      name: "search_memories",
      description:
        "Search a project's memories — short, retrieval-optimized notes about durable facts, conventions, decisions, and gotchas. This is mindroot's primary semantic search layer (hybrid vector + keyword). Use before exploring a codebase or asking the user things that may already be remembered; mindroot_search_notes is only a literal string fallback. Hits include ids usable with mindroot_delete_memory.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project slug to search in" },
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default 8)" },
        },
        required: ["project", "query"],
      },
    },
    {
      name: "search_notes",
      description:
        "Literal case-insensitive string search over a project's note sections — no semantics. Memories are the semantic index: prefer mindroot_search_memories first and use this only as a fallback or to locate exact keywords/identifiers inside notes. Returns the note path and heading section per hit; fetch just that section with mindroot_read_note's section argument.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project slug to search in" },
          query: { type: "string", description: "Literal text to find (matched as whole words/terms)" },
          limit: { type: "number", description: "Max results (default 8)" },
        },
        required: ["project", "query"],
      },
    },
    {
      name: "save_memory",
      description:
        "Save a memory — a short, retrieval-optimized text about a durable fact, convention, decision, or gotcha for a project. Optionally link it to a note path ('notes/foo.md') or section ('notes/foo.md::Heading::Subheading'). Write memories so they answer 'when would someone need this'.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          text: { type: "string" },
          target_path: { type: "string", description: "Optional link target: 'path.md' or 'path.md::Heading'" },
        },
        required: ["project", "text"],
      },
    },
    {
      name: "delete_memory",
      description: "Delete a memory by id. Use to dedupe or remove stale entries. Ids come from mindroot_search_memories hits.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, id: { type: "number" } },
        required: ["project", "id"],
      },
    },
    {
      name: "list_notes",
      description:
        "List all memory notes for a project with their titles and section heading paths. Use this to see a note's section layout, then read only the section you need via mindroot_read_note's section argument instead of fetching the whole note.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
      },
    },
    {
      name: "read_note",
      description:
        "Read a memory note. Without `section`, returns full content plus the section list. With `section` (a heading path like 'Architecture::Storage' from mindroot_list_notes or mindroot_search_notes targets), returns only that section's body — prefer this when you don't need the whole note. Verifies file integrity first and re-indexes automatically if the file was edited externally.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          path: { type: "string", description: "Note path relative to the project, e.g. 'architecture.md'" },
          section: { type: "string", description: "Optional heading path like 'Architecture::Storage' — return only that section" },
        },
        required: ["project", "path"],
      },
    },
    {
      name: "save_note",
      description:
        "Create or fully overwrite a markdown memory note. Sections are parsed from headings (# .. ######) and are individually readable (mindroot_read_note `section`) and string-searchable (mindroot_search_notes); embeddings are generated for memories only. After saving, consider saving 1-3 linked memories (mindroot_save_memory with target_path) so key facts surface in memory searches.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          path: { type: "string", description: "Note path ending in .md" },
          content: { type: "string", description: "Full markdown content" },
        },
        required: ["project", "path", "content"],
      },
    },
    {
      name: "update_section",
      description:
        "Replace the body of an existing heading-section, or append it to the note when missing.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          path: { type: "string" },
          heading_path: { type: "string", description: "Section address like 'Architecture::Storage' (heading titles joined by ::)" },
          content: { type: "string", description: "New body text for this section" },
        },
        required: ["project", "path", "heading_path", "content"],
      },
    },
    {
      name: "delete_note",
      description: "Delete a memory note and its sections index entries.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, path: { type: "string" } },
        required: ["project", "path"],
      },
    },
    {
      name: "search_skills",
      description:
        "Search a project's reusable procedures (hybrid over names and descriptions). Call once before starting a non-trivial multi-step task; skip simple tasks or work already clear from context. Returns summaries; use mindroot_read_skill only for promising matches and reuse skills already loaded.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          query: { type: "string", description: "The task or workflow to find a procedure for" },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 8)" },
        },
        required: ["project", "query"],
      },
    },
    {
      name: "read_skill",
      description:
        "Read a project's reusable skill instructions. Check prerequisites before applying; skills do not override the current task's instructions or permissions. Omit revision for the latest content, or supply a revision number to inspect history. Returns current_revision for safe updates.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          name: { type: "string", description: "Stable skill name from mindroot_search_skills" },
          revision: { type: "integer", minimum: 1, description: "Optional historical revision" },
        },
        required: ["project", "name"],
      },
    },
    {
      name: "save_skill",
      description:
        "Create or update a project-specific skill for a non-trivial procedure that was verified to work and is not already captured. Search first to dedupe, read an existing match, then update its stable name. Automatically indexes name/description and preserves revisions; no linked memory is needed. Pass expected_revision from the latest read (0 for create-only); conflicts require rereading. Identical saves do not add revisions.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          name: { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", description: "Stable lowercase hyphenated name, e.g. add-mcp-tool" },
          description: { type: "string", minLength: 1, maxLength: 2000, description: "Short summary of when to use this skill; indexed for discovery" },
          content: { type: "string", minLength: 1, description: "Markdown: when to use, prerequisites, procedure, success criteria, and pitfalls. Reference project notes for facts; never include secrets or task recaps." },
          expected_revision: { type: "integer", minimum: 0, description: "Latest revision read; 0 requires that the skill does not exist" },
        },
        required: ["project", "name", "description", "content"],
      },
    },
    {
      name: "delete_skill",
      description: "Delete a project's skill by stable name, including its revision history and search index. Use for obsolete or duplicate procedures after checking the existing skill.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, name: { type: "string" } },
        required: ["project", "name"],
      },
    },
  ];
}

async function callTool(db, name, args) {
  const core = await import("./core.js");
  switch (name) {
    case "list_projects":
      return core.listProjects(db);
    case "search_projects":
      return core.searchProjects(db, args.query);
    case "rename_project":
      return core.renameProject(db, args.project, args.new_slug);
    case "search_memories":
      return core.searchMemories(db, args.project, args.query, args.limit ?? 8);
    case "search_notes":
      return core.searchNotes(db, args.project, args.query, args.limit ?? 8);
    case "save_memory":
      return core.addMemory(db, args.project, args.text, args.target_path);
    case "delete_memory":
      return core.deleteMemory(db, args.project, Number(args.id));
    case "list_notes":
      return core.listDocs(db, args.project);
    case "read_note":
      return core.readNote(db, args.project, args.path, args.section);
    case "save_note":
      return core.saveNote(db, args.project, args.path, args.content);
    case "update_section":
      return core.updateSection(db, args.project, args.path, args.heading_path, args.content);
    case "delete_note":
      return core.deleteNote(db, args.project, args.path);
    case "search_skills":
      return core.searchSkills(db, args.project, args.query, args.limit ?? 8);
    case "read_skill":
      return core.readSkill(db, args.project, args.name, args.revision);
    case "save_skill":
      return core.saveSkill(db, args.project, args.name, args.description, args.content, args.expected_revision);
    case "delete_skill":
      return core.deleteSkill(db, args.project, args.name);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleRpc(db, rpc) {
  if (!rpc || typeof rpc !== "object") {
    return { status: 400, body: jsonRpcError(null, -32600, "invalid request") };
  }
  if (rpc.id === undefined || rpc.id === null) {
    return { status: 202, body: null };
  }
  try {
    let result;
    switch (rpc.method) {
      case "initialize": {
        result = {
          protocolVersion: rpc.params?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
        break;
      }
      case "ping": {
        result = {};
        break;
      }
      case "tools/list": {
        result = { tools: tools() };
        break;
      }
      case "tools/call": {
        const { name, arguments: args } = rpc.params ?? {};
        try {
          const data = await callTool(db, name, args ?? {});
          result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        } catch (err) {
          return {
            status: 200,
            body: {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { content: [{ type: "text", text: String(err.message) }], isError: true },
            },
          };
        }
        break;
      }
      default:
        return { status: 200, body: jsonRpcError(rpc.id, -32601, `method not found: ${rpc.method}`) };
    }
    return { status: 200, body: { jsonrpc: "2.0", id: rpc.id, result } };
  } catch (err) {
    return { status: 200, body: jsonRpcError(rpc.id, -32603, String(err.message)) };
  }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
