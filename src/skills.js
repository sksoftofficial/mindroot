import { validSlug, ensureProject, getProjectRow, httpError } from "./indexer.js";
import { embedDoc, embedQuery } from "./embedder.js";
import { ONNX_MODEL_ID } from "./paths.js";
import { rankSkills } from "./search.js";

function validateProject(slug) {
  if (!slug) throw httpError(400, "project is required");
  if (!validSlug(slug)) throw httpError(400, `invalid project slug: ${slug}`);
}

function validateName(name) {
  if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw httpError(400, "skill name must be 1-64 lowercase letters/digits separated by single hyphens");
  }
}

function validateRevision(revision, minimum) {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < minimum)) {
    throw httpError(400, `revision must be an integer >= ${minimum}`);
  }
}

function findSkill(db, projectId, name) {
  return db.prepare("SELECT * FROM skills WHERE project_id = ? AND name = ?").get(projectId, name);
}

function summary(row) {
  return {
    name: row.name,
    description: row.description,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSkills(db, slug) {
  validateProject(slug);
  const project = getProjectRow(db, slug);
  return db.prepare(
    "SELECT name, description, revision, created_at, updated_at FROM skills WHERE project_id = ? ORDER BY name",
  ).all(project.id);
}

export function readSkill(db, slug, name, revision) {
  validateProject(slug);
  validateName(name);
  validateRevision(revision, 1);
  const project = getProjectRow(db, slug);
  const current = findSkill(db, project.id, name);
  if (!current) throw httpError(404, `skill not found: ${name}`);
  const row = revision === undefined ? current : db.prepare(
    "SELECT description, content, revision, saved_at AS updated_at FROM skill_revisions WHERE skill_id = ? AND revision = ?",
  ).get(current.id, revision);
  if (!row) throw httpError(404, `skill revision not found: ${name}@${revision}`);
  return { ...summary({ ...current, ...row }), content: row.content, current_revision: current.revision };
}

// Embed before opening the transaction; never hold a write lock during model inference.
export async function saveSkill(db, slug, name, description, content, expectedRevision, embed = embedDoc) {
  validateProject(slug);
  validateName(name);
  validateRevision(expectedRevision, 0);
  if (typeof description !== "string" || !description.trim() || description.length > 2000) {
    throw httpError(400, "skill description is required (maximum 2000 characters)");
  }
  if (typeof content !== "string" || !content.trim()) throw httpError(400, "skill content is required");
  description = description.trim();
  const project = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
  const previous = project && findSkill(db, project.id, name);
  const previousRevision = previous?.revision ?? 0;
  if (expectedRevision !== undefined && expectedRevision !== previousRevision) {
    throw httpError(409, "skill changed; read the latest revision before saving");
  }
  if (previous?.description === description && previous.content === content) {
    return { ...summary(previous), unchanged: true };
  }

  const vec = await embed(`${name}\n${description}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const currentProject = db.prepare("SELECT id FROM projects WHERE slug = ?").get(slug);
    if (project && currentProject?.id !== project.id) {
      throw httpError(409, "project changed while saving skill; resolve the project again");
    }
    const target = currentProject ?? ensureProject(db, slug);
    const current = findSkill(db, target.id, name);
    if ((current?.revision ?? 0) !== previousRevision || current?.id !== previous?.id) {
      throw httpError(409, "skill changed; read the latest revision before saving");
    }
    const now = Date.now();
    const revision = previousRevision + 1;
    const row = db.prepare(
      `INSERT INTO skills (project_id, name, description, content, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET
         description = excluded.description, content = excluded.content,
         revision = excluded.revision, updated_at = excluded.updated_at
       RETURNING *`,
    ).get(target.id, name, description, content, revision, now, now);
    db.prepare(
      "INSERT INTO skill_revisions (skill_id, revision, description, content, saved_at) VALUES (?, ?, ?, ?, ?)",
    ).run(row.id, revision, description, content, now);
    db.prepare(
      `INSERT INTO skill_embeddings (skill_id, dim, model, vec) VALUES (?, ?, ?, ?)
       ON CONFLICT(skill_id) DO UPDATE SET dim = excluded.dim, model = excluded.model, vec = excluded.vec`,
    ).run(row.id, vec.length, ONNX_MODEL_ID, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    db.exec("COMMIT");
    return { ...summary(row), unchanged: false };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function deleteSkill(db, slug, name) {
  validateProject(slug);
  validateName(name);
  const project = getProjectRow(db, slug);
  const result = db.prepare("DELETE FROM skills WHERE project_id = ? AND name = ?").run(project.id, name);
  if (!result.changes) throw httpError(404, `skill not found: ${name}`);
  return { deleted: name };
}

export async function searchSkills(db, slug, query, limit = 8) {
  validateProject(slug);
  if (typeof query !== "string" || !query.trim()) throw httpError(400, "query is required");
  const project = getProjectRow(db, slug);
  const n = Number(limit);
  const count = Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), 1), 100) : 8;
  if (!db.prepare("SELECT 1 FROM skills WHERE project_id = ? LIMIT 1").get(project.id)) return [];
  return rankSkills(db, project.id, await embedQuery(query), query, count);
}
