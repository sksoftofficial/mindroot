import { api, parseArgs } from "./cli-api.js";

function fmtDate(ts) {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16);
}

function projectFlag(flags) {
  const p = flags.project;
  if (!p) throw new Error("--project <slug> is required");
  return p;
}

export async function projects() {
  const rows = await api("GET", "/api/projects");
  if (!rows.length) return console.log("no projects yet");
  for (const r of rows) {
    console.log(`${r.slug}  (${r.docs} notes, ${r.memories} memories)`);
  }
}

export async function searchCmd(argv) {
  const { positional, flags } = parseArgs(argv);
  const query = positional.join(" ");
  if (!query) throw new Error('usage: mindroot search "query" --project <slug>');
  const hits = await api("POST", "/api/search", {
    project: projectFlag(flags),
    query,
    limit: Number(flags.limit ?? 8),
  });
  if (!hits.length) return console.log("no results");
  for (const [i, h] of hits.entries()) {
    const target = h.target ? `\n    -> ${h.target}` : "";
    console.log(`${i + 1}. [${h.score.toFixed(3)}] ${h.kind}${h.doc_title ? ` in "${h.doc_title}"` : ""}${target}`);
    console.log(`   ${h.text.replace(/\s+/g, " ").slice(0, 200)}`);
    console.log(`   updated ${fmtDate(h.updated_at)}`);
  }
}

export async function saveMemoryCmd(argv) {
  const { positional, flags } = parseArgs(argv);
  const text = positional.join(" ");
  if (!text) throw new Error('usage: mindroot save-memory "text" --project <slug> [--link "note.md::Heading"]');
  const out = await api("POST", `/api/projects/${flags.project}/memories`, {
    text,
    target_path: flags.link,
  });
  console.log(`saved memory #${out.id} (${out.target_type})`);
}

export async function memoriesCmd(argv) {
  const { flags } = parseArgs(argv);
  const rows = await api("GET", `/api/projects/${projectFlag(flags)}/memories`);
  if (!rows.length) return console.log("no memories");
  for (const r of rows) {
    console.log(`#${r.id}  ${r.text}`);
    if (r.target_path) console.log(`     -> ${r.target_path}`);
  }
}

export async function notesCmd(argv) {
  const { flags, positional } = parseArgs(argv);
  const slug = projectFlag(flags);
  if (positional[0]) {
    const doc = await api("GET", `/api/projects/${slug}/doc?path=${encodeURIComponent(positional[0])}`);
    console.log(`# ${doc.title}\n`);
    for (const s of doc.sections) {
      console.log(s.path ? `[${s.path}]` : "[preamble]");
    }
    console.log("\n" + "-".repeat(40));
    process.stdout.write(doc.content);
    return;
  }
  const docs = await api("GET", `/api/projects/${slug}/docs`);
  if (!docs.length) return console.log("no notes");
  for (const d of docs) {
    console.log(`${d.path}  "${d.title}" (${d.sections.length} sections)`);
    for (const s of d.sections) console.log(`   - ${s || "(preamble)"}`);
  }
}
