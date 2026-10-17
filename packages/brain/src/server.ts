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
import { derivedTerms } from "./om/agents.ts";
import { tagValue, teamMemory } from "./agents/memory.ts";
import { AGENT_NAMES, AGENTS, agentByName } from "./agents/roster.ts";
import { memoryDb } from "./brain/store.ts";
import { chatWithAgent, foundryAgentName } from "./foundry/client.ts";

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

// ---------------------------------------------------------------------------------------------- the agent team (/team)

const OM_PUBLIC = process.env.OPENMETADATA_PUBLIC_URL ?? cfg.om.url;

function team() {
  return {
    agents: AGENTS.map((a) => ({ name: a.name, displayName: a.displayName, team: a.team, role: a.role, foundryAgent: foundryAgentName(a) })),
    foundry: { configured: !!cfg.foundry.endpoint, project: cfg.foundry.project || cfg.foundry.endpoint.split("/").pop(), model: cfg.foundry.model },
    memory: { db: cfg.memory.db, space: cfg.memory.team },
    openmetadata: { url: OM_PUBLIC, memories: `${OM_PUBLIC}/context-center/memories` },
  };
}

async function teamChat(req: IncomingMessage, res: ServerResponse) {
  const { agent, message, conversationId } = await readBody(req);
  const a = agentByName(String(agent));
  if (!a || !message) return json(res, 400, { error: "agent and message are required" });
  const t0 = Date.now();
  const turn = await chatWithAgent(a, String(message), conversationId ? String(conversationId) : undefined);
  json(res, 200, { ...turn, ms: Date.now() - t0 });
}

/** The team's memories, newest first, straight from Atlas, with whether OpenMetadata already mirrors each one. */
async function teamMemoryFeed() {
  const docs = await (await memoryDb())
    .collection("memories")
    .find({ user_id: cfg.memory.team, tier: "stm" }, { projection: { embedding: 0 } })
    .sort({ created_at: -1 })
    .limit(60)
    .toArray();
  let mirrored = new Set<string>();
  try {
    const list = await new OM().get<any>("/contextCenter/memories?limit=200");
    mirrored = new Set((list.data ?? []).map((m: any) => String(m.name).replace(/^agent-memory-/, "")));
  } catch {}
  return {
    count: docs.length,
    memories: docs.map((d: any) => {
      const agent = tagValue(d.tags ?? [], "agent") ?? "";
      return { id: String(d._id), agent, agentName: AGENT_NAMES[agent] ?? agent, content: d.content, topic: tagValue(d.tags ?? [], "topic"), account: tagValue(d.tags ?? [], "account"), createdAt: d.created_at, inCatalog: mirrored.has(String(d._id)) };
    }),
  };
}

/** What OpenMetadata holds about the agents' memory: Context Center memories (authored by each agent's bot) and lineage. */
async function teamCatalog() {
  const om = new OM();
  const list = await om.get<any>("/contextCenter/memories?limit=200&fields=owners,primaryEntity,relatedEntities");
  const memories = (list.data ?? [])
    .filter((m: any) => String(m.name).startsWith("agent-memory-"))
    .sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map((m: any) => ({
      id: String(m.name).replace(/^agent-memory-/, ""),
      question: m.question,
      answer: m.answer,
      author: m.updatedBy,
      owner: m.owners?.[0]?.displayName ?? m.owners?.[0]?.name,
      agent: m.primaryEntity?.displayName ?? m.primaryEntity?.name,
      linked: (m.relatedEntities ?? []).map((r: any) => ({ type: r.type, name: r.displayName ?? r.name })),
      updatedAt: m.updatedAt,
    }));
  let lineage: { upstream: string[]; downstream: string[] } = { upstream: [], downstream: [] };
  try {
    const l = await om.lineage("table", `wisteria_atlas.default.${cfg.memory.db}.memories`, 1, 1);
    const names = new Map<string, string>((l.nodes ?? []).map((n: any) => [n.id, n.displayName ?? n.name]));
    lineage = { upstream: (l.upstreamEdges ?? []).map((e: any) => names.get(e.fromEntity)).filter(Boolean), downstream: (l.downstreamEdges ?? []).map((e: any) => names.get(e.toEntity)).filter(Boolean) };
  } catch {}
  const proposed = (await derivedTerms(om).catch(() => [])).map((t: any) => ({ fqn: t.fullyQualifiedName, name: t.displayName ?? t.name, parent: t.parent?.fullyQualifiedName, status: t.entityStatus ?? t.status, by: /Proposed by the (.+?) from team memory/.exec(String(t.description))?.[1], updatedAt: t.updatedAt }));
  return { memories, proposed, lineage, table: `wisteria_atlas.default.${cfg.memory.db}.memories`, url: OM_PUBLIC };
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
    if (url.pathname === "/api/team") return json(res, 200, team());
    if (req.method === "POST" && url.pathname === "/api/team/chat") return await teamChat(req, res);
    if (url.pathname === "/api/team/memory") return json(res, 200, await teamMemoryFeed());
    if (url.pathname === "/api/team/catalog") return json(res, 200, await teamCatalog());
    if (url.pathname === "/api/status") return json(res, 200, await status());
    if (url.pathname === "/api/record") {
      const id = url.searchParams.get("id") ?? "";
      if (id.startsWith("memory:")) {
        const m: any = await teamMemory.get(id);
        return m ? json(res, 200, { _id: id, source: "memory", kind: `${AGENT_NAMES[tagValue(m.tags, "agent") ?? ""] ?? "agent"} memory`, title: m.content.slice(0, 110), text: m.content, ts: m.created_at, meta: { tier: m.tier, importance: m.importance, tags: m.tags, store: `MongoDB Atlas · ${cfg.memory.db}.memories` } }) : json(res, 404, { error: "not found" });
      }
      const { docs } = await colls();
      const d = await docs.findOne({ _id: id });
      return d ? json(res, 200, d) : json(res, 404, { error: "not found" });
    }
    return serveStatic(req, res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e) });
    else res.end();
  }
}).listen(PORT, process.env.BRAIN_API_HOST ?? "127.0.0.1", () => console.log(`brain API on http://${process.env.BRAIN_API_HOST ?? "127.0.0.1"}:${PORT}`));
