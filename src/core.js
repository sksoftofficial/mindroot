import fs from "node:fs/promises";
import path from "node:path";
import {
  projectDir,
  safeJoin,
  validSlug,
  ensureProject,
  getProjectRow,
  verifyAndLoadDoc,
  reindexDoc,
  httpError,
} from "./indexer.js";
import { appendSection, parseMarkdown, replaceSectionBody } from "./markdown.js";
import { embedDoc } from "./embedder.js";
import { ONNX_MODEL_ID } from "./paths.js";
import { searchMemories as hybridSearchMemories, searchNotes as hybridSearchNotes, searchProjects } from "./search.js";

export { searchProjects };
export { listSkills, readSkill, saveSkill, deleteSkill, searchSkills } from "./skills.js";

export async function listProjects(db) {
  return db
    .prepare(
      `SELECT p.slug, p.created_at,
              (SELECT COUNT(*) FROM docs d WHERE d.project_id = p.id) AS docs,
              (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id) AS memories,
              (SELECT COUNT(*) FROM skills s WHERE s.project_id = p.id) AS skills
       FROM projects p ORDER BY p.slug`,
    )
    .all();
}

export function getProject(db, slug) {
  return getProjectRow(db, slug);
}

export async function deleteProject(db, slug) {
  const project = getProjectRow(db, slug);
  await fs.rm(projectDir(slug), { recursive: true, force: true });
  db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  return { deleted: slug };
}

export async function renameProject(db, from, to) {
  const project = getProjectRow(db, from);
  if (to === from) throw httpError(400, `project is already named: ${from}`);
  if (!validSlug(to)) throw httpError(400, `invalid project slug: ${to}`);
  if (db.prepare("SELECT id FROM projects WHERE slug = ?").get(to)) {
    throw httpError(409, `project already exists: ${to}`);
  }
  const targetDir = projectDir(to);
  if (await fs.stat(targetDir).then(() => true, () => false)) {
    throw httpError(409, `directory already exists: ${to}`);
  }
  // A project containing only skills or memories may have no notes directory.
  const hasNotes = await fs.stat(projectDir(from)).then(() => true, (err) => {
    if (err.code === "ENOENT") return false;
    throw err;
  });
  if (hasNotes) await fs.rename(projectDir(from), targetDir);
  db.prepare("UPDATE projects SET slug = ? WHERE id = ?").run(to, project.id);
  db.prepare("DELETE FROM project_embeddings WHERE project_id = ?").run(project.id);
  return { renamed: { from, to } };
}

export async function listDocs(db, slug) {
  const project = getProjectRow(db, slug);
  const docs = db
    .prepare("SELECT id, rel_path, title, indexed_at FROM docs WHERE project_id = ? ORDER BY rel_path")
    .all(project.id);
  const result = [];
  for (const doc of docs) {
    const sections = db
      .prepare("SELECT heading_path FROM sections WHERE doc_id = ? ORDER BY id")
      .all(doc.id)
      .map((r) => r.heading_path);
    result.push({ path: doc.rel_path, title: doc.title, sections });
  }
  return result;
}

export async function readNote(db, slug, relPath, section) {
  await verifyAndLoadDoc(db, slug, relPath);
  const project = getProjectRow(db, slug);
  const doc = db
    .prepare("SELECT * FROM docs WHERE project_id = ? AND rel_path = ?")
    .get(project.id, relPath);
  const content = await fs.readFile(safeJoin(slug, relPath), "utf8");
  const parsed = parseMarkdown(content);
  if (section !== undefined && section !== null) {
    const sec = parsed.sections.find((s) => s.path === section);
    if (!sec) throw httpError(404, `section not found: ${section}`);
    return {
      path: relPath,
      title: doc.title,
      section,
      updated_at: doc.indexed_at,
      content: sec.body,
    };
  }
  return {
    path: relPath,
    title: doc.title,
    updated_at: doc.indexed_at,
    sections: parsed.sections.map((s) => ({ path: s.path, level: s.level })),
    content,
  };
}

// Serializes read-modify-write cycles per note file so concurrent calls
// (parallel tool batches, overlapping sessions) interleave safely.
const noteWrites = new Map();

function withNoteWrite(full, fn) {
  const prev = noteWrites.get(full) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  noteWrites.set(full, run.then(
    () => {},
    () => {},
  ));
  return run;
}

async function readRawNote(full) {
  try {
    return await fs.readFile(full, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeNote(db, slug, relPath, content) {
  const full = safeJoin(slug, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");
  const stat = await fs.stat(full);
  await reindexDoc(db, slug, relPath, content, Math.floor(stat.mtimeMs));
  return readNote(db, slug, relPath);
}

export function saveNote(db, slug, relPath, content, oldContent) {
  const full = safeJoin(slug, relPath);
  return withNoteWrite(full, async () => {
    const current = await readRawNote(full);
    if (current === null) {
      if (oldContent !== undefined && oldContent !== null && oldContent !== "") {
        throw httpError(400, `note does not exist yet: ${relPath} (create it without old_content)`);
      }
    } else {
      if (typeof oldContent !== "string") {
        throw httpError(
          400,
          `old_content required to overwrite existing note: ${relPath} (pass its exact current content from mindroot_read_note)`,
        );
      }
      if (oldContent !== current) {
        throw httpError(
          409,
          `conflict: note '${relPath}' changed since read (expected ${oldContent.length} chars, current ${current.length}). Re-read the note, merge your changes, and retry with its current content as old_content`,
        );
      }
    }
    return writeNote(db, slug, relPath, content);
  });
}

export async function deleteNote(db, slug, relPath) {
  const full = safeJoin(slug, relPath);
  const project = getProjectRow(db, slug);
  try {
    await fs.unlink(full);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const doc = db
    .prepare("SELECT id FROM docs WHERE project_id = ? AND rel_path = ?")
    .get(project.id, relPath);
  if (doc) {
    const ids = db.prepare("SELECT id FROM sections WHERE doc_id = ?").all(doc.id).map((r) => r.id);
    for (const sid of ids) {
      db.prepare("DELETE FROM embeddings WHERE owner_type = 'section' AND owner_id = ?").run(sid);
    }
    db.prepare("DELETE FROM docs WHERE id = ?").run(doc.id);
  }
  db.prepare(
    "UPDATE memories SET target_path = NULL, updated_at = ? WHERE project_id = ? AND (target_path = ? OR target_path LIKE ?)",
  ).run(Date.now(), project.id, relPath, relPath + "::%");
  return { deleted: relPath };
}

export function updateSection(db, slug, relPath, headingPath, oldContent, newContent) {
  const full = safeJoin(slug, relPath);
  return withNoteWrite(full, async () => {
    const { content } = await verifyAndLoadDoc(db, slug, relPath);
    const parsed = parseMarkdown(content);
    const sec = parsed.sections.find((s) => s.path === headingPath);
    if (!sec) {
      if (oldContent === "") {
        return writeNote(db, slug, relPath, appendSection(content, headingPath, newContent));
      }
      throw httpError(
        typeof oldContent === "string" && oldContent ? 409 : 400,
        `section not found: ${headingPath} (pass old_content: "" to append it as a new section)`,
      );
    }
    if (typeof oldContent !== "string") {
      throw httpError(
        400,
        `old_content required: pass the exact current body of section '${headingPath}' from mindroot_read_note`,
      );
    }
    if (sec.body !== oldContent) {
      throw httpError(
        409,
        `conflict: section '${headingPath}' in '${relPath}' changed since read (expected ${oldContent.length} chars, current ${sec.body.length}). Re-read the section and retry with its current body as old_content`,
      );
    }
    return writeNote(db, slug, relPath, replaceSectionBody(content, sec, newContent));
  });
}

export async function listMemories(db, slug) {
  const project = getProjectRow(db, slug);
  return db
    .prepare(
      "SELECT id, text, target_type, target_path, created_at, updated_at FROM memories WHERE project_id = ? ORDER BY id",
    )
    .all(project.id);
}

export async function addMemory(db, slug, text, targetPath) {
  if (!text?.trim()) throw httpError(400, "memory text is required");
  let targetType = "standalone";
  if (targetPath) {
    if (!targetPath.includes(".md")) throw httpError(400, "target_path must reference a note (.md or .md::Heading)");
    targetType = targetPath.includes("::") ? "section" : "doc";
  }
  const project = getProjectRow(db, slug) ?? ensureProject(db, slug);
  const now = Date.now();
  const res = db
    .prepare(
      "INSERT INTO memories (project_id, text, target_type, target_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(project.id, text.trim(), targetType, targetPath ?? null, now, now);
  const id = Number(res.lastInsertRowid);
  const vec = await embedDoc(text.trim());
  db.prepare(
    "INSERT INTO embeddings (owner_type, owner_id, dim, model, vec) VALUES ('memory', ?, ?, ?, ?)",
  ).run(id, vec.length, ONNX_MODEL_ID, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  return { id, target_type: targetType };
}

export async function deleteMemory(db, slug, id) {
  const project = getProjectRow(db, slug);
  const row = db
    .prepare("SELECT id FROM memories WHERE project_id = ? AND id = ?")
    .get(project.id, id);
  if (!row) throw httpError(404, `memory not found: ${id}`);
  db.prepare("DELETE FROM embeddings WHERE owner_type = 'memory' AND owner_id = ?").run(id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return { deleted: id };
}

function scopedProject(db, slug) {
  if (!slug) throw httpError(400, "project is required");
  return getProjectRow(db, slug).id;
}

function cleanLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 8;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

export async function searchMemories(db, slug, query, limit) {
  return hybridSearchMemories(db, scopedProject(db, slug), query, cleanLimit(limit));
}

export async function searchNotes(db, slug, query, limit) {
  return hybridSearchNotes(db, scopedProject(db, slug), query, cleanLimit(limit));
}
