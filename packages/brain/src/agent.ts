import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "./config.ts";
import { brainNow } from "./brain/store.ts";
import { BRAIN_TOOLS } from "./brain/tools.ts";
import { OM } from "./om/client.ts";
import { OM_MCP_READ_TOOLS, OM_MCP_URL, OM_MCP_WRITE_TOOLS } from "./om/mcp.ts";
import type { Citation } from "./brain/types.ts";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; name: string; citations: Citation[]; data?: unknown; error?: string }
  | { type: "done"; sessionId?: string; durationMs: number; costUsd?: number }
  | { type: "error"; message: string };

async function systemPrompt() {
  const now = (await brainNow()).toISOString().slice(0, 10);
  return `You are the company brain of Wisteria Group, a B2B fintech (~20,000 employees, ~6,000 customers).
You answer from one unified memory on MongoDB Atlas built from Salesforce, Zendesk, Gong, Slack, Jira, Confluence and Google Drive,
governed by OpenMetadata (glossary, owners, domains, lineage). The brain's "today" is ${now}.

How to work:
- Ground every statement in tool results. Never invent names, numbers or events.
- Cite each factual claim inline with the exact marker the tools return, e.g. [[zendesk:ticket:123]] or [[om:glossaryTerm:WisteriaGlossary.ARR]]. Cite 1–3 records per claim.
- For a company: call account_360 first, then search_brain (scoped to that account) for the evidence behind risks or opportunities.
- For any metric or business term (ARR, churn, health, escalation…): call explain_data and use the governed definition and owner.
- For "this quarter"/"what changed": call what_changed (91 days by default).
- Prefer several targeted tool calls over one vague one. Use get_record when a single item needs detail.${cfg.om.mcpToken ? `
- OpenMetadata's own MCP tools (search_metadata, get_entity_details, get_entity_lineage, semantic_search, find_context) answer catalog questions beyond explain_data: what a dataset contains, who owns any asset, full lineage, where a column flows. You yourself are cataloged as the AI application \`company_brain_agent\`; your inputs are the tables wisteria_atlas.default.wisteria_brain.docs, .chunks and .entities (start lineage questions there). Keep lineage calls shallow (upstreamDepth/downstreamDepth ≤ 2, no column lineage unless asked) and cite catalog assets as [[om:<entityType>:<fullyQualifiedName>]], e.g. [[om:table:era_salesforce.wisteria.salesforce.Contact]].` : ""}

Answer format: lead with the direct answer in 1–2 sentences. Then short sections by theme (not by tool) with cited bullets.
End with "Next best actions" (2–3 bullets) when the question is about a customer. If data is missing or thin, say so plainly.`;
}

/** [[om:<type>:<fqn>]] markers from OpenMetadata MCP answers → citations the UI can render and open. */
function catalogCitations(text: string, seen: Set<string>): Citation[] {
  const om = new OM();
  const out: Citation[] = [];
  for (const m of text.matchAll(/\[\[(om:([a-zA-Z]+):([^\]]+))\]\]/g)) {
    const [, id, type, fqn] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source: "openmetadata", kind: type === "table" ? "dataset" : type, title: fqn, url: om.url(type, fqn), ts: new Date().toISOString() });
  }
  return out;
}

/** Stream one turn of the brain agent. Pass the previous sessionId to continue a conversation. */
export async function* askBrain(prompt: string, sessionId?: string): AsyncGenerator<AgentEvent> {
  const t0 = Date.now();
  const pending: AgentEvent[] = [];
  const seen = new Set<string>(); // citation ids already sent to the UI
  let answer = "";
  const server = createSdkMcpServer({
    name: "brain",
    version: "0.1.0",
    tools: BRAIN_TOOLS.map((t) =>
      tool(t.name, t.description, t.shape, async (args: any) => {
        try {
          const r = await t.run(args);
          r.citations.forEach((c) => seen.add(c.id));
          pending.push({ type: "tool_result", name: t.name, citations: r.citations, data: r.data });
          return { content: [{ type: "text", text: r.text }] };
        } catch (e) {
          pending.push({ type: "tool_result", name: t.name, citations: [], error: String(e) });
          return { content: [{ type: "text", text: `Error: ${String(e)}` }], isError: true };
        }
      }),
    ),
  });

  const cwd = path.join(os.tmpdir(), "wisteria-brain-agent");
  mkdirSync(cwd, { recursive: true });
  try {
    for await (const msg of query({
      prompt,
      options: {
        model: cfg.agent.model,
        systemPrompt: await systemPrompt(),
        mcpServers: {
          brain: server,
          // OpenMetadata's built-in MCP server, as the read-only company-brain-bot
          ...(cfg.om.mcpToken ? { openmetadata: { type: "http" as const, url: OM_MCP_URL, headers: { Authorization: `Bearer ${cfg.om.mcpToken}` } } } : {}),
        },
        tools: [],
        allowedTools: [...BRAIN_TOOLS.map((t) => `mcp__brain__${t.name}`), ...(cfg.om.mcpToken ? OM_MCP_READ_TOOLS.map((t) => `mcp__openmetadata__${t}`) : [])],
        disallowedTools: OM_MCP_WRITE_TOOLS.map((t) => `mcp__openmetadata__${t}`),
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 14,
        cwd,
        ...(sessionId ? { resume: sessionId } : {}),
      },
    })) {
      if (msg.type === "stream_event") {
        const ev: any = msg.event;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          answer += ev.delta.text;
          yield { type: "text", delta: ev.delta.text };
        }
      } else if (msg.type === "assistant") {
        for (const block of (msg.message.content ?? []) as any[]) {
          if (block.type === "tool_use") yield { type: "tool_start", id: block.id, name: String(block.name).replace(/^mcp__brain__/, "").replace(/^mcp__openmetadata__/, "openmetadata:"), input: block.input };
        }
      } else if (msg.type === "result") {
        while (pending.length) yield pending.shift()!;
        const catalog = catalogCitations(answer, seen);
        if (catalog.length) yield { type: "tool_result", name: "openmetadata", citations: catalog };
        if (msg.subtype !== "success") yield { type: "error", message: `agent stopped: ${msg.subtype}` };
        yield { type: "done", sessionId: msg.session_id, durationMs: Date.now() - t0, costUsd: (msg as any).total_cost_usd };
        return;
      }
      while (pending.length) yield pending.shift()!;
    }
  } catch (e) {
    yield { type: "error", message: String(e) };
  }
}
