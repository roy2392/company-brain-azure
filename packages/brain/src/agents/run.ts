import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { cfg } from "../config.ts";
import { brainNow } from "../brain/store.ts";
import { BRAIN_TOOLS, resolveAccount } from "../brain/tools.ts";
import type { OM } from "../om/client.ts";
import { MEMORY_TOOLS, type RunRecord } from "../om/agents.ts";
import { saveRun, syncRun, type RunJournal } from "./journal.ts";
import { AGENTS, type WisteriaAgent } from "./roster.ts";
import { teamMemory } from "./memory.ts";
import { memoryTools } from "./memory-tools.ts";

export type AgentRunEvent =
  | { type: "start"; agent: string; task: string; runId: string }
  | { type: "text"; agent: string; delta: string }
  | { type: "tool"; agent: string; name: string; input: unknown }
  | { type: "recall"; agent: string; query: string; hits: Array<{ id: string; by: string; content: string }> }
  | { type: "remember"; agent: string; id: string; fact: string; question: string }
  | { type: "done"; agent: string; answer: string; durationMs: number; costUsd?: number; tools: number; remembered: number; omExecution?: string; omMemories: number; omError?: string }
  | { type: "error"; agent: string; message: string };

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

async function systemPrompt(a: WisteriaAgent) {
  const others = AGENTS.filter((x) => x.name !== a.name).map((x) => x.displayName).join(" and the ");
  return `${a.role}
You are the ${a.displayName} at Wisteria Group, a B2B fintech (~20,000 employees, ~6,000 customers). The company brain's "today" is ${day(await brainNow())}.
Your brain tools read one unified memory of Salesforce, Zendesk, Gong, Slack, Jira, Confluence and Google Drive on MongoDB Atlas, governed by OpenMetadata.

You share a team memory with the ${others}. It lives in MongoDB Atlas (agent-memory) and is cataloged in OpenMetadata.
How to work:
1. Call recall_team_memory first, with the account and your topic. Treat what teammates saved as established: cite it as [[memory:<id>]] and do not re-investigate it.
2. Use your brain tools only for the gaps. Ground every statement in tool results and cite records inline exactly as the tools return them, e.g. [[zendesk:ticket:123]]. Never make up an id.
3. Save 2–4 durable findings with remember: one fact per call, self-contained (name the account, dates and amounts), with the source ids inline in the fact, e.g. "(zendesk:ticket:123)". Give the question each fact answers. Do not save what the team memory already holds.
4. Finish with a brief for your team: at most 150 words, cited bullets.`;
}

/** Run one Wisteria agent on a task: brain tools + the team's shared memory, recorded in OpenMetadata. */
export async function* runAgent(a: WisteriaAgent, task: string, opts: { account?: string; om?: OM | null } = {}): AsyncGenerator<AgentRunEvent> {
  const runId = randomUUID().slice(0, 8);
  const t0 = Date.now();
  const pending: AgentRunEvent[] = [];
  const calls: RunRecord["toolCalls"] = [];
  const remembered: RunJournal["remembered"] = [];
  const acct = opts.account ? await resolveAccount(opts.account) : null;
  let answer = "";

  /** every tool runs in-process: timed and logged for the OpenMetadata execution record */
  const timed = (name: string, fn: (args: any) => Promise<string>) => async (args: any) => {
    const at = Date.now();
    pending.push({ type: "tool", agent: a.name, name, input: args });
    try {
      const text = await fn(args);
      calls.push({ name, input: args, ok: true, at, ms: Date.now() - at });
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      calls.push({ name, input: args, ok: false, at, ms: Date.now() - at });
      return { content: [{ type: "text" as const, text: `Error: ${String(e)}` }], isError: true };
    }
  };

  const brainTools = BRAIN_TOOLS.filter((t) => a.tools.includes(t.name)).map((t) => tool(t.name, t.description, t.shape, timed(t.name, async (args) => (await t.run(args)).text)));
  const memTools = memoryTools(a, {
    runId,
    account: acct?.name,
    onRecall: (q, hits) => pending.push({ type: "recall", agent: a.name, query: q, hits }),
    onRemember: (m) => {
      remembered.push({ id: m.id, fact: m.fact, question: m.question, topic: m.topic, concepts: m.concepts, newConcept: m.newConcept });
      pending.push({ type: "remember", agent: a.name, id: m.id, fact: m.fact, question: m.question });
    },
  }).map((t) => tool(t.name, t.description, t.shape, timed(t.name, t.run)));

  const server = createSdkMcpServer({ name: "wisteria", version: "0.1.0", tools: [...brainTools, ...memTools] });
  const cwd = path.join(os.tmpdir(), "wisteria-agents");
  mkdirSync(cwd, { recursive: true });
  yield { type: "start", agent: a.name, task, runId };

  let costUsd: number | undefined;
  let sessionId: string | undefined;
  let error: string | undefined;
  try {
    for await (const msg of query({
      prompt: task,
      options: {
        model: cfg.agent.model,
        systemPrompt: await systemPrompt(a),
        mcpServers: { wisteria: server },
        tools: [],
        allowedTools: [...a.tools, ...MEMORY_TOOLS].map((t) => `mcp__wisteria__${t}`),
        settingSources: [],
        includePartialMessages: true,
        maxTurns: 16,
        cwd,
      },
    })) {
      if (msg.type === "stream_event") {
        const ev: any = msg.event;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          answer += ev.delta.text;
          yield { type: "text", agent: a.name, delta: ev.delta.text };
        }
      } else if (msg.type === "result") {
        costUsd = (msg as any).total_cost_usd;
        sessionId = msg.session_id;
        if (msg.subtype !== "success") error = `agent stopped: ${msg.subtype}`;
      }
      while (pending.length) yield pending.shift()!;
    }
  } catch (e) {
    error = String(e);
  }
  while (pending.length) yield pending.shift()!;
  if (error) yield { type: "error", agent: a.name, message: error };

  // episodic memory: what this agent did, searchable by its teammates
  await teamMemory
    .logActivity(a.name, runId, [{ type: "human", content: task }, { type: "ai", content: answer, tool_calls: calls.map((c) => ({ name: c.name, args: c.input })) }], sessionId)
    .catch((e) => pending.push({ type: "error", agent: a.name, message: `episodic log: ${String(e)}` }));

  // governance: journal the run, then record it and the memories it wrote in OpenMetadata
  const journal: RunJournal = { agent: a.name, account: acct?.name, runId, task, answer, startedAt: t0, endedAt: Date.now(), toolCalls: calls, costUsd, sessionId, error, remembered, om: { memories: [] } };
  saveRun(journal);
  let omExecution: string | undefined;
  let omMemories = 0;
  let omError: string | undefined;
  if (opts.om) {
    const r = await syncRun(opts.om, journal);
    omExecution = r.execution;
    omMemories = r.memories;
    if (r.errors.length) omError = r.errors.join("; ");
  }
  while (pending.length) yield pending.shift()!;
  yield { type: "done", agent: a.name, answer, durationMs: Date.now() - t0, costUsd, tools: calls.length, remembered: remembered.length, omExecution, omMemories, omError };
}
