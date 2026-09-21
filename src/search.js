import { embedQuery, embedDoc } from "./embedder.js";
import { ONNX_MODEL_ID } from "./paths.js";

function toFloat32(buf) {
  const ab = buf instanceof Uint8Array ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf;
  return new Float32Array(ab);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function ftsQuery(query) {
  const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

function tokenize(s) {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function slugBonus(slug, queryTokens) {
  if (!queryTokens.length) return 0;
  const slugTokens = tokenize(slug);
  let matched = 0;
  for (const qt of queryTokens) {
    if (
      slugTokens.some(
        (st) =>
          st === qt ||
          (qt.length >= 3 && st.length >= 3 && (st.startsWith(qt) || qt.startsWith(st))),
      )
    )
      matched++;
  }
  return matched / queryTokens.length;
}

export async function searchProjects(db, query) {
  await backfillProjectVectors(db);
  return rankProjects(db, await embedQuery(query), query);
}

export function rankProjects(db, qvec, query) {
  const queryTokens = tokenize(query);

  const projects = db
    .prepare(
      `SELECT p.id, p.slug, pe.vec
       FROM projects p
       LEFT JOIN project_embeddings pe ON pe.project_id = p.id`,
    )
    .all();

  const hits = [];
  for (const p of projects) {
    const cos = p.vec ? cosine(qvec, toFloat32(p.vec)) : 0;
    const bonus = slugBonus(p.slug, queryTokens);
    const score = bonus > 0 ? Math.max(cos, 0.55 + 0.4 * bonus) : cos;
    if (bonus > 0 || score >= 0.5) {
      hits.push({ kind: "project", id: p.id, project: p.slug, score });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

export async function backfillProjectVectors(db) {
  const projects = db
    .prepare(
      `SELECT p.id, p.slug FROM projects p
       LEFT JOIN project_embeddings pe ON pe.project_id = p.id
       WHERE pe.project_id IS NULL`,
    )
    .all();
  for (const p of projects) {
    const vec = await embedDoc(p.slug);
    db.prepare(
      "INSERT INTO project_embeddings (project_id, dim, model, vec) VALUES (?, ?, ?, ?)",
    ).run(p.id, vec.length, ONNX_MODEL_ID, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }
}

export async function searchMemories(db, projectId, query, limit = 8) {
  return rankMemories(db, projectId, await embedQuery(query), query, limit);
}

export function rankMemories(db, projectId, qvec, query, limit = 8) {
  const rows = db
    .prepare(
      `SELECT e.owner_id, e.vec, m.text AS mtext, m.target_path, m.updated_at
       FROM embeddings e
       JOIN memories m ON m.id = e.owner_id
       WHERE e.owner_type = 'memory' AND m.project_id = $pid`,
    )
    .all({ pid: projectId });

  const byId = new Map();
  for (const row of rows) {
    const vec = toFloat32(row.vec);
    if (vec.length !== qvec.length) continue;
    byId.set(row.owner_id, {
      kind: "memory",
      id: row.owner_id,
      text: row.mtext,
      target: row.target_path,
      doc_title: null,
      score: cosine(qvec, vec),
      updated_at: row.updated_at,
    });
  }

  applyFts(db, projectId, query, byId);

  return rank(byId, limit);
}

export function rankSkills(db, projectId, qvec, query, limit = 8) {
  const rows = db.prepare(
    `SELECT s.id, s.name, s.description, s.revision, s.updated_at, e.vec
     FROM skills s LEFT JOIN skill_embeddings e ON e.skill_id = s.id
     WHERE s.project_id = ?`,
  ).all(projectId);
  const byId = new Map();
  for (const row of rows) {
    const vec = row.vec && toFloat32(row.vec);
    byId.set(row.id, {
      kind: "skill", name: row.name, description: row.description,
      revision: row.revision, updated_at: row.updated_at,
      score: vec?.length === qvec.length ? cosine(qvec, vec) : 0,
    });
  }
  const fq = ftsQuery(query);
  if (fq) {
    const matches = db.prepare(
      `SELECT s.id, bm25(skills_fts) AS rank FROM skills_fts
       JOIN skills s ON s.id = skills_fts.rowid
       WHERE skills_fts MATCH ? AND s.project_id = ? ORDER BY rank LIMIT 100`,
    ).all(fq, projectId);
    const max = Math.max(0, ...matches.map((r) => -r.rank));
    for (const match of matches) byId.get(match.id).fts = max ? -match.rank / max : 1;
  }
  return rank(byId, limit);
}

function applyFts(db, projectId, query, byId) {
  const fq = ftsQuery(query);
  if (!fq) return;
  try {
    const ftsRows = db
      .prepare(
        `SELECT rowid, bm25(memories_fts) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT 50`,
      )
      .all(fq);
    const ranks = new Map();
    let maxRank = 0;
    for (const r of ftsRows) {
      const norm = -r.rank;
      if (norm > maxRank) maxRank = norm;
      ranks.set(r.rowid, norm);
    }
    if (!ranks.size) return;
    const allowed = new Set(
      db
        .prepare(`SELECT id FROM memories WHERE project_id = ? AND id IN (${[...ranks.keys()].map(() => "?").join(",")})`)
        .all(projectId, ...ranks.keys())
        .map((r) => r.id),
    );
    for (const [rid, rank] of ranks) {
      if (!allowed.has(rid)) continue;
      const hit = byId.get(rid);
      if (hit) hit.fts = maxRank ? rank / maxRank : 1;
    }
  } catch {
    // malformed query — keyword layer skipped, vector results still returned
  }
}

export function searchNotes(db, projectId, query, limit = 8) {
  return rankNotes(db, projectId, query, limit);
}

export function rankNotes(db, projectId, query, limit = 8) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!terms.length) return [];
  const rows = db
    .prepare(
      `SELECT s.id, s.content, s.heading_path, s.updated_at,
              d.rel_path, d.title AS dtitle
       FROM sections s
       JOIN docs d ON d.id = s.doc_id
       WHERE d.project_id = $pid`,
    )
    .all({ pid: projectId });

  const hits = [];
  for (const row of rows) {
    const heading = row.heading_path.toLowerCase();
    const content = (row.content ?? "").toLowerCase();
    let matched = 0;
    let headingMatched = false;
    for (const term of terms) {
      if (heading.includes(term)) headingMatched = true;
      if (heading.includes(term) || content.includes(term)) matched++;
    }
    if (!matched) continue;
    hits.push({
      kind: "note_section",
      id: row.id,
      text: row.content?.slice(0, 300),
      target: `${row.rel_path}::${row.heading_path}`,
      doc_title: row.dtitle,
      score: matched / terms.length + (headingMatched ? 0.25 : 0),
      updated_at: row.updated_at,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.updated_at - a.updated_at);
  return hits.slice(0, limit);
}

function rank(byId, limit) {
  const scored = [...byId.values()].map((h) => ({
    ...h,
    score: h.score * 0.75 + (h.fts ?? 0) * 0.25,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
