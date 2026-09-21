import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "../paths.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT,
  mtime INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL,
  UNIQUE(project_id, rel_path)
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  heading_path TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(doc_id, heading_path)
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('standalone','doc','section')),
  target_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('memory','section')),
  owner_id INTEGER NOT NULL,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL,
  UNIQUE(owner_type, owner_id)
);

CREATE TABLE IF NOT EXISTS project_embeddings (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS skill_revisions (
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY(skill_id, revision)
);

CREATE TABLE IF NOT EXISTS skill_embeddings (
  skill_id INTEGER PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name,
  description,
  content='skills',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description) VALUES (new.id, new.name, new.description);
END;

CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description)
  VALUES ('delete', old.id, old.name, old.description);
END;

CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE OF name, description ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description)
  VALUES ('delete', old.id, old.name, old.description);
  INSERT INTO skills_fts(rowid, name, description) VALUES (new.id, new.name, new.description);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO memories_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS memories_embeddings_ad AFTER DELETE ON memories BEGIN
  DELETE FROM embeddings WHERE owner_type = 'memory' AND owner_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS sections_embeddings_ad AFTER DELETE ON sections BEGIN
  DELETE FROM embeddings WHERE owner_type = 'section' AND owner_id = old.id;
END;
`;

function migrate(db) {
  const hasDocs =
    db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'docs'").get().n > 0;
  if (!hasDocs) return;
  const docCols = db.prepare("PRAGMA table_info(docs)").all().map((c) => c.name);
  if (!docCols.includes("content_hash")) {
    db.exec("ALTER TABLE docs ADD COLUMN content_hash TEXT");
  }
  // Section embeddings were removed from the design — memories are the only semantic note index.
  db.prepare("DELETE FROM embeddings WHERE owner_type = 'section'").run();
}

export function open() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  return db;
}

export function ensureSchema(db) {
  db.exec(SCHEMA);
  migrate(db);
}
