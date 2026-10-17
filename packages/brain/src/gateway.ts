/**
 * The only door the Foundry agents get into the brain (npm run gateway, exposed with a Microsoft Dev Tunnel):
 *   POST /agents/<agent>/mcp               that agent's brain tools + the shared-memory tools (MCP, streamable HTTP, stateless)
 *   /agents/<agent>/openmetadata/mcp       OpenMetadata's MCP server as that agent's own bot, read tools only
 * Both need Authorization: Bearer <agentKey(agent)>. OpenMetadata bot tokens never leave this machine:
 * the gateway attaches the agent's token itself. Everything else is 404.
 */
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { memoryTools } from "./agents/memory-tools.ts";
import { agentByName, AGENTS, type WisteriaAgent } from "./agents/roster.ts";
import { BRAIN_TOOLS } from "./brain/tools.ts";
import { cfg } from "./config.ts";
import { agentKey, sameSecret } from "./foundry/keys.ts";
import { agentToken, promoteMemory } from "./om/agents.ts";
import { OM } from "./om/client.ts";
import { OM_MCP_AGENT_TOOLS } from "./om/mcp.ts";

const om = await new OM().login().catch(() => null);
const log = (agent: string, msg: string) => console.log(`${new Date().toISOString().slice(11, 19)} [${agent}] ${msg}`);

const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** A fresh MCP server per request (stateless): the agent's brain tools plus the shared-memory tools. */
function agentServer(a: WisteriaAgent) {
  const server = new McpServer(
    { name: `wisteria-${a.name.replace(/_/g, "-")}`, version: "0.1.0" },
    { instructions: `Wisteria Group's company brain (MongoDB Atlas) and the team memory shared by Wisteria's agents (agent-memory). You are serving the ${a.displayName}. Cite records with the [[id]] markers the tools return.` },
  );
  const wrap = (name: string, run: (args: any) => Promise<string>) => async (args: any) => {
    log(a.name, `→ ${name} ${JSON.stringify(args).slice(0, 160)}`);
    try {
      return { content: [{ type: "text" as const, text: await run(args) }] };
    } catch (e) {
      log(a.name, `✗ ${name}: ${String(e).slice(0, 200)}`);
      // returned as text, not isError: Foundry fails the whole response on an MCP tool error
      return { content: [{ type: "text" as const, text: `The ${name} tool failed: ${String(e).slice(0, 300)}. Try another tool or answer with what you have.` }] };
    }
  };
  for (const t of BRAIN_TOOLS.filter((x) => a.tools.includes(x.name))) server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, wrap(t.name, async (args) => (await t.run(args)).text));
  const memTools = memoryTools(a, {
    runId: "foundry",
    onRecall: (q, hits) => log(a.name, `⟲ recalled ${hits.length} memories for "${q}"`),
    onRemember: async (m) => {
      log(a.name, `✚ remembered ${m.id}: ${m.fact.slice(0, 100)}`);
      if (om) await promoteMemory(om, a, { ...m, runId: "foundry" }).catch((e) => log(a.name, `OpenMetadata mirror failed: ${String(e).slice(0, 160)}`));
    },
  });
  for (const t of memTools) server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, wrap(t.name, t.run));
  return server;
}

/** Forward to OpenMetadata's MCP endpoint as the agent's own bot, refusing every tool that is not read-only. */
async function proxyOpenMetadata(a: WisteriaAgent, req: IncomingMessage, res: ServerResponse) {
  if (!om) return send(res, 503, { error: "OpenMetadata is not reachable" });
  const body = await readBody(req);
  if (body.length) {
    const msgs = [JSON.parse(body.toString())].flat();
    for (const m of msgs) {
      if (m?.method === "tools/call" && !OM_MCP_AGENT_TOOLS.includes(m.params?.name)) {
        log(a.name, `✗ blocked OpenMetadata ${m.params?.name}`);
        return send(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${m.params?.name} is not available: the gateway only forwards ${OM_MCP_AGENT_TOOLS.join(", ")}.` }] } });
      }
      if (m?.method === "tools/call") log(a.name, `→ openmetadata:${m.params?.name} ${JSON.stringify(m.params?.arguments ?? {}).slice(0, 140)}`);
    }
  }
  const target = new URL("/mcp", cfg.om.url);
  const headers: Record<string, string> = { authorization: `Bearer ${await agentToken(om, a)}` };
  for (const h of ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"]) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  if (body.length) headers["content-length"] = String(body.length);
  const upstream = request(target, { method: req.method, headers }, (up) => {
    // buffered (responses are small) so tool errors can be turned into text: Foundry fails the whole response on one
    const chunks: Buffer[] = [];
    up.on("data", (c) => chunks.push(c));
    up.on("end", () => {
      const text = Buffer.concat(chunks).toString().replace(/"isError"\s*:\s*true/g, '"isError":false');
      const headers = Object.fromEntries(Object.entries(up.headers).filter(([k]) => !["connection", "transfer-encoding", "content-length"].includes(k))) as any;
      res.writeHead(up.statusCode ?? 502, { ...headers, "content-length": Buffer.byteLength(text) });
      res.end(text);
    });
  });
  upstream.on("error", (e) => (res.headersSent ? res.end() : send(res, 502, { error: String(e) })));
  upstream.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway");
  const path = url.pathname.replace(/\/+$/, "");
  try {
    if (path === "/healthz") return send(res, 200, { ok: true, agents: AGENTS.map((a) => a.name) });
    const m = path.match(/^\/agents\/([a-z_]+)\/(mcp|openmetadata\/mcp)$/);
    if (m) {
      const a = agentByName(m[1]);
      if (!a || !sameSecret(bearer(req), agentKey(a.name))) return send(res, 401, { error: "unauthorized" });
      if (m[2] === "openmetadata/mcp") return await proxyOpenMetadata(a, req, res);
      if (req.method !== "POST") return send(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
      const raw = await readBody(req);
      const server = agentServer(a);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw.length ? JSON.parse(raw.toString()) : undefined);
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: String(e).slice(0, 300) });
    else res.end();
  }
}).listen(cfg.gateway.port, cfg.gateway.host, () => {
  console.log(`Foundry gateway on http://${cfg.gateway.host}:${cfg.gateway.port} (agents: ${AGENTS.map((a) => a.name).join(", ")})${cfg.gateway.publicUrl ? ` → ${cfg.gateway.publicUrl}` : ""}`);
  if (!cfg.gateway.secret && !process.env.FOUNDRY_AGENT_KEYS) console.warn("neither FOUNDRY_AGENT_KEYS nor FOUNDRY_GATEWAY_SECRET is set: agent endpoints will refuse every request");
});
