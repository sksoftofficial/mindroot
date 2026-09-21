import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { NOTES_DIR } from "./paths.js";
import { parseMarkdown, docTitle } from "./markdown.js";

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function validSlug(slug) {
  return typeof slug === "string" && /^[\w][\w.-]{0,63}$/.test(slug);
}

export function projectDir(slug) {
  return path.join(NOTES_DIR, slug);
}

export function safeJoin(slug, relPath) {
  if (typeof relPath !== "string" || !relPath.endsWith(".md")) {
    throw httpError(400, "note path must end with .md");
  }
  const base = path.resolve(projectDir(slug));
  const p = path.resolve(base, relPath);
  if (p !== base && !p.startsWith(base + path.sep)) {
    throw httpError(400, "invalid note path");
  }
  return p;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function walkMd(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMd(p)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(path.relative(dir, p));
  }
  return out.sort();
}

function upsertSection(db, docId, headingPath, content) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sections (doc_id, heading_path, content, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(doc_id, heading_path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).run(docId, headingPath, content, now);
}

export async function reindexDoc(db, slug, relPath, content, mtime) {
  ensureProject(db, slug);
  const project = getProjectRow(db, slug);
  let doc = db
    .prepare("SELECT * FROM docs WHERE project_id = ? AND rel_path = ?")
    .get(project.id, relPath);
  if (!doc) {
    const res = db
      .prepare(
        "INSERT INTO docs (project_id, rel_path, title, content_hash, mtime, indexed_at) VALUES (?, ?, '', NULL, ?, ?)",
      )
      .run(project.id, relPath, mtime, Date.now());
    doc = { id: Number(res.lastInsertRowid) };
  }

  const parsed = parseMarkdown(content);
  const title = docTitle(parsed, path.basename(relPath));
  const hash = sha256(content);
  db.prepare("UPDATE docs SET title = ?, content_hash = ?, mtime = ?, indexed_at = ? WHERE id = ?").run(
    title,
    hash,
    mtime,
    Date.now(),
    doc.id,
  );

  const existing = new Map(
    db.prepare("SELECT id, heading_path, content FROM sections WHERE doc_id = ?").all(doc.id).map((r) => [r.heading_path, r]),
  );
  for (const sec of parsed.sections) {
    if (!sec.body.trim()) continue;
    const prev = existing.get(sec.path);
    existing.delete(sec.path);
    if (prev && prev.content === sec.body) continue;
    upsertSection(db, doc.id, sec.path, sec.body);
  }
  for (const stale of existing.values()) {
    db.prepare("DELETE FROM embeddings WHERE owner_type = 'section' AND owner_id = ?").run(stale.id);
    db.prepare("DELETE FROM sections WHERE id = ?").run(stale.id);
  }
}

export async function syncProject(db, slug) {
  const dir = projectDir(slug);
  const files = await walkMd(dir);
  for (const rel of files) {
    const full = path.join(dir, rel);
    const stat = await fs.stat(full);
    const content = await fs.readFile(full, "utf8");
    await reindexDoc(db, slug, rel, content, Math.floor(stat.mtimeMs));
  }
  const project = getProjectRow(db, slug);
  const known = new Set(files.map((f) => path.normalize(f)));
  const rows = db.prepare("SELECT id, rel_path FROM docs WHERE project_id = ?").all(project.id);
  for (const row of rows) {
    if (!known.has(path.normalize(row.rel_path))) {
      await removeDocRows(db, row.id);
    }
  }
}

async function removeDocRows(db, docId) {
  const ids = db.prepare("SELECT id FROM sections WHERE doc_id = ?").all(docId).map((r) => r.id);
  for (const sid of ids) {
    db.prepare("DELETE FROM embeddings WHERE owner_type = 'section' AND owner_id = ?").run(sid);
  }
  db.prepare("DELETE FROM docs WHERE id = ?").run(docId);
}

export async function verifyAndLoadDoc(db, slug, relPath) {
  const project = getProjectRow(db, slug);
  const full = safeJoin(slug, relPath);
  let content;
  try {
    content = await fs.readFile(full, "utf8");
  } catch {
    const doc = db
      .prepare("SELECT id FROM docs WHERE project_id = ? AND rel_path = ?")
      .get(project.id, relPath);
    if (doc) await removeDocRows(db, doc.id);
    throw httpError(404, `note not found: ${relPath}`);
  }
  const stat = await fs.stat(full);
  const hash = sha256(content);
  const doc = db
    .prepare("SELECT * FROM docs WHERE project_id = ? AND rel_path = ?")
    .get(project.id, relPath);
  if (!doc || doc.content_hash !== hash || !doc.content_hash) {
    await reindexDoc(db, slug, relPath, content, Math.floor(stat.mtimeMs));
  }
  return { content, mtime: Math.floor(stat.mtimeMs), hash };
}

export function getProjectRow(db, slug) {
  if (!validSlug(slug)) throw httpError(400, `invalid project slug: ${slug}`);
  const row = db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug);
  if (!row) throw httpError(404, `unknown project: ${slug}`);
  return row;
}

export function ensureProject(db, slug) {
  if (!validSlug(slug)) throw httpError(400, `invalid project slug: ${slug}`);
  db.prepare("INSERT OR IGNORE INTO projects (slug, created_at) VALUES (?, ?)").run(slug, Date.now());
  return getProjectRow(db, slug);
}
