import { z } from "zod";
import { resolveAccount } from "../brain/tools.ts";
import { AGENT_NAMES, AGENTS, type WisteriaAgent } from "./roster.ts";
import { memoryId, tagValue, teamMemory } from "./memory.ts";

/**
 * The three shared-memory tools every Wisteria agent gets, defined once for both runtimes:
 * the Claude Agent SDK agents (agents/run.ts) and the Foundry agents (gateway MCP server).
 */
export interface MemoryToolHooks {
  runId: string;
  /** account the run is about, when the runtime knows it (tagged on every memory) */
  account?: string;
  onRecall?(query: string, hits: Array<{ id: string; by: string; content: string }>): void;
  onRemember?(m: { id: string; fact: string; question: string; topic?: string; account?: string }): void | Promise<void>;
}

export interface MemoryTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  run(args: any): Promise<string>;
}

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

export function memoryTools(a: WisteriaAgent, hooks: MemoryToolHooks): MemoryTool[] {
  return [
    {
      name: "recall_team_memory",
      description: "Recall what Wisteria's agents (you and your teammates) already know: hybrid search over the team's shared memory in MongoDB Atlas (agent-memory). Call it before investigating.",
      shape: { query: z.string().describe("What you need to know, e.g. 'Novaris Holdings escalations root cause'"), limit: z.number().int().min(1).max(15).optional() },
      async run({ query, limit }) {
        const hits = await teamMemory.recall(query, limit ?? 8);
        hooks.onRecall?.(query, hits.map((m) => ({ id: m._id, by: tagValue(m.tags, "agent") ?? "?", content: m.content })));
        if (!hits.length) return "Team memory has nothing on this yet.";
        return hits.map((m) => `[[${memoryId(m._id)}]] ${AGENT_NAMES[tagValue(m.tags, "agent") ?? ""] ?? "unknown agent"} · ${day(m.created_at)} · ${m.content}`).join("\n");
      },
    },
    {
      name: "remember",
      description: "Save one durable finding to the team's shared memory so the other agents can reuse it. One self-contained fact per call, with source ids inline.",
      shape: {
        fact: z.string().min(30).describe("Self-contained fact: account, what, when, how much, with source ids inline, e.g. '(zendesk:ticket:123)'"),
        question: z.string().describe("The question this fact answers, e.g. 'Why did Novaris Holdings churn?'"),
        topic: z.string().optional().describe("Short topic tag, e.g. escalations, churn-reason, arr-impact"),
        account: z.string().optional().describe("The customer this is about, e.g. 'Novaris Holdings'"),
      },
      async run({ fact, question, topic, account }) {
        const name = account ?? hooks.account;
        const acct = name ? await resolveAccount(name) : null;
        const id = await teamMemory.remember(a.name, fact, { runId: hooks.runId, account: acct?._id.replace(/^account:/, ""), topic });
        await hooks.onRemember?.({ id, fact, question, topic, account: acct?.name ?? name });
        return `Saved to team memory as [[${memoryId(id)}]].`;
      },
    },
    {
      name: "team_activity",
      description: "What the other agents did recently (their tasks, tools and answers), from agent-memory's episodic log.",
      shape: { query: z.string(), agent: z.string().optional().describe(`One of ${AGENTS.map((x) => x.name).join(", ")}`) },
      async run({ query, agent }) {
        const turns = await teamMemory.searchActivity(query, { agent, limit: 5 });
        if (!turns.length) return "No logged activity matches.";
        return turns.map((t) => `${AGENT_NAMES[t.agent_name ?? ""] ?? t.agent_name} · run ${t.thread_id} · ${day(t.ts ?? t.created_at ?? new Date())}\n    ${(t.search_text ?? "").replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
      },
    },
  ];
}
