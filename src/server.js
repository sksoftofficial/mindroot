import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handleRpc } from "./mcp.js";
import { validSlug, ensureProject, getProjectRow } from "./indexer.js";
import * as core from "./core.js";

const DASHBOARD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard");
const DASHBOARD = path.join(DASHBOARD_DIR, "index.html");
const DASHBOARD_ASSETS = new Map([
  ["/favicon.png", ["favicon.png", "image/png"]],
  ["/logo.png", ["logo.png", "image/png"]],
  ["/graph.js", ["graph.js", "text/javascript; charset=utf-8"]],
  ["/vendor/force-graph.min.js", [fileURLToPath(new URL("./force-graph.min.js", import.meta.resolve("force-graph"))), "text/javascript; charset=utf-8"]],
]);

export function createServer(db, cfg) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${cfg.port}`);
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
        const html = await fs.readFile(DASHBOARD, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      const asset = DASHBOARD_ASSETS.get(url.pathname);
      if (req.method === "GET" && asset) {
        const body = await fs.readFile(path.resolve(DASHBOARD_DIR, asset[0]));
        res.writeHead(200, {
          "content-type": asset[1],
          "cache-control": asset[0] === "graph.js" ? "no-cache" : "public, max-age=86400",
        });
        res.end(body);
        return;
      }

      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (!authorized(req, cfg)) {
        sendJson(res, 401, {
          error: "unauthorized",
          hint: "the apiKey in ~/.mindroot/config.json changed — update the Authorization Bearer key in your MCP client config",
        });
        return;
      }

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        const rpc = await readJson(req);
        const out = await handleRpc(db, rpc);
        if (out.body === null) {
          res.writeHead(out.status);
          res.end();
        } else {
          sendJson(res, out.status, out.body);
        }
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, db);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const status = err.status ?? 500;
      sendJson(res, status, { error: String(err.message) });
    }
  });
}

async function handleApi(req, res, url, db) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[1] === "projects") {
    const slug = parts[2];
    if (!slug) {
      if (req.method === "GET") return sendJson(res, 200, await core.listProjects(db));
      if (req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 201, ensureProject(db, body.slug));
      }
      throw methodNotAllowed();
    }
    if (!validSlug(slug)) throw badRequest("invalid project slug");

    if (parts.length === 3) {
      if (req.method === "GET") {
        const project = getProjectRow(db, slug);
        const [docs, memories, skills] = await Promise.all([
          core.listDocs(db, slug), core.listMemories(db, slug), core.listSkills(db, slug),
        ]);
        return sendJson(res, 200, { slug, id: project.id, docs, memories, skills });
      }
      if (req.method === "DELETE") return sendJson(res, 200, await core.deleteProject(db, slug));
      throw methodNotAllowed();
    }

    if (parts[3] === "skills") {
      if (parts.length === 4 && req.method === "GET") return sendJson(res, 200, core.listSkills(db, slug));
      if (parts.length !== 5) throw notFound();
      const name = decodeURIComponent(parts[4]);
      if (req.method === "GET") {
        const revision = url.searchParams.get("revision");
        return sendJson(res, 200, core.readSkill(db, slug, name, revision === null ? undefined : Number(revision)));
      }
      if (req.method === "PUT") {
        const body = await readJson(req);
        return sendJson(res, 200, await core.saveSkill(db, slug, name, body.description, body.content, body.expected_revision));
      }
      if (req.method === "DELETE") return sendJson(res, 200, core.deleteSkill(db, slug, name));
      throw methodNotAllowed();
    }
    if (parts[3] === "docs") {
      if (req.method === "GET") return sendJson(res, 200, await core.listDocs(db, slug));
      throw methodNotAllowed();
    }
    if (parts[3] === "doc") {
      const relPath = url.searchParams.get("path");
      if (!relPath) throw badRequest("path query param required");
      if (req.method === "GET")
        return sendJson(res, 200, await core.readNote(db, slug, relPath, url.searchParams.get("section") ?? undefined));
      if (req.method === "PUT") {
        const body = await readJson(req);
        return sendJson(res, 200, await core.saveNote(db, slug, relPath, body.content ?? ""));
      }
      if (req.method === "DELETE") return sendJson(res, 200, await core.deleteNote(db, slug, relPath));
      throw methodNotAllowed();
    }
    if (parts[3] === "sections") {
      if (req.method === "POST") {
        const body = await readJson(req);
        return sendJson(
          res,
          200,
          await core.updateSection(db, slug, body.path, body.heading_path, body.content),
        );
      }
      throw methodNotAllowed();
    }
    if (parts[3] === "memories") {
      if (req.method === "GET" && !parts[4]) return sendJson(res, 200, await core.listMemories(db, slug));
      if (req.method === "POST") {
        const body = await readJson(req);
        return sendJson(res, 201, await core.addMemory(db, slug, body.text, body.target_path));
      }
      if (req.method === "DELETE" && parts[4]) {
        return sendJson(res, 200, await core.deleteMemory(db, slug, Number(parts[4])));
      }
      throw methodNotAllowed();
    }
    throw notFound();
  }

  if (parts[1] === "search" && req.method === "POST") {
    const body = await readJson(req);
    const limit = body.limit ?? 8;
    let hits;
    if (body.kind === "memories") {
      hits = await core.searchMemories(db, body.project, body.query, limit);
    } else if (body.kind === "notes") {
      hits = await core.searchNotes(db, body.project, body.query, limit);
    } else if (body.kind === "skills") {
      hits = await core.searchSkills(db, body.project, body.query, limit);
    } else {
      const [memories, notes] = await Promise.all([
        core.searchMemories(db, body.project, body.query, limit),
        core.searchNotes(db, body.project, body.query, limit),
      ]);
      hits = [...memories, ...notes].sort((a, b) => b.score - a.score).slice(0, limit);
    }
    return sendJson(res, 200, hits);
  }

  throw notFound();
}

function authorized(req, cfg) {
  const expected = `Bearer ${cfg.apiKey}`;
  const got = req.headers.authorization ?? "";
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid json body"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

const badRequest = (m) => Object.assign(new Error(m), { status: 400 });
const notFound = () => Object.assign(new Error("not found"), { status: 404 });
const methodNotAllowed = () => Object.assign(new Error("method not allowed"), { status: 405 });
