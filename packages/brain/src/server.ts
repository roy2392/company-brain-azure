/**
 * HTTP API for the showcase UI (and anything else):
 *   POST /api/chat    {prompt, sessionId?} → text/event-stream of AgentEvent
 *   GET  /api/record?id=…                  → one BrainDoc (full text)
 *   GET  /api/status                        → what the brain holds right now
 * In production it also serves the built UI from apps/web/dist.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { askBrain } from "./agent.ts";
import { cfg } from "./config.ts";
import { getEmbedder } from "./brain/embed.ts";
import { brainNow, colls } from "./brain/store.ts";
import { OM } from "./om/client.ts";

const PORT = Number(process.env.BRAIN_API_PORT ?? 8787);
const DIST = path.join(cfg.root, "apps", "web", "dist");

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

async function status() {
  const { docs, chunks, entities } = await colls();
  const [bySource, chunkCount, byType, now, embedder] = await Promise.all([
    docs.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$source", n: { $sum: 1 } } }]).toArray(),
    chunks.estimatedDocumentCount(),
    entities.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$type", n: { $sum: 1 } } }]).toArray(),
    brainNow(),
    getEmbedder(),
  ]);
  let om: Record<string, unknown> = { ok: false, url: cfg.om.url };
  try {
    const client = new OM();
    const [version, tables, terms] = await Promise.all([
      client.get("/system/version"),
      client.search("*", "table_search_index", 0),
      client.search("*", "glossary_term_search_index", 0),
    ]);
    om = { ok: true, url: cfg.om.url, version: version.version, tables: tables.hits?.total?.value ?? 0, glossaryTerms: terms.hits?.total?.value ?? 0 };
  } catch {}
  return {
    atlas: { uri: cfg.mongo.uri.replace(/\/\/[^@]*@/, "//***@"), db: cfg.mongo.db, cloud: cfg.mongo.uri.startsWith("mongodb+srv") },
    docs: Object.fromEntries(bySource.map((s) => [s._id, s.n])),
    chunks: chunkCount,
    entities: Object.fromEntries(byType.map((t) => [t._id, t.n])),
    now,
    embeddings: embedder ? embedder.model : null,
    model: cfg.agent.model,
    om,
  };
}

async function chat(req: IncomingMessage, res: ServerResponse) {
  const { prompt, sessionId } = await readBody(req);
  if (!prompt || typeof prompt !== "string") return json(res, 400, { error: "prompt is required" });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let closed = false;
  req.on("close", () => (closed = true));
  for await (const ev of askBrain(prompt, sessionId)) {
    if (closed) break;
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (!existsSync(DIST)) return json(res, 404, { error: "UI not built — run `npm run dev` for the dev server" });
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(DIST, "index.html");
  const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff2": "font/woff2" }[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && url.pathname === "/api/chat") return await chat(req, res);
    if (url.pathname === "/api/status") return json(res, 200, await status());
    if (url.pathname === "/api/record") {
      const { docs } = await colls();
      const d = await docs.findOne({ _id: url.searchParams.get("id") ?? "" });
      return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
    }
    return serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
}).listen(PORT, () => console.log(`brain API on http://localhost:${PORT}`));
