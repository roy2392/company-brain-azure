import { z } from "zod";
import { resolveAccount } from "../brain/tools.ts";
import { CONCEPT_NAMES, matchConcepts, type NewConcept } from "../om/agents.ts";
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
  onRemember?(m: { id: string; fact: string; question: string; topic?: string; account?: string; concepts?: string[]; newConcept?: NewConcept }): void | Promise<void>;
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
      shape: { query: z.string().describe("What you need to know, e.g. 'Novaris Holdings escalations root cause'"), limit: z.number().optional().describe("1–15 (default 8)") },
      async run({ query, limit }) {
        const hits = await teamMemory.recall(query, Math.min(15, Math.max(1, Math.round(limit ?? 8))));
        hooks.onRecall?.(query, hits.map((m) => ({ id: m._id, by: tagValue(m.tags, "agent") ?? "?", content: m.content })));
        if (!hits.length) return "Team memory has nothing on this yet.";
        return hits.map((m) => `[[${memoryId(m._id)}]] ${AGENT_NAMES[tagValue(m.tags, "agent") ?? ""] ?? "unknown agent"} · ${day(m.created_at)} · ${m.content}`).join("\n");
      },
    },
    {
      name: "remember",
      description: "Save one durable finding to the team's shared memory so the other agents can reuse it. One self-contained fact per call, with source ids inline.",
      shape: {
        fact: z.string().describe("Self-contained fact (a full sentence or two): account, what, when, how much, with source ids inline, e.g. '(zendesk:ticket:123)'"),
        question: z.string().optional().describe("The question this fact answers, e.g. 'Why did Novaris Holdings churn?'"),
        topic: z.string().optional().describe("Short topic tag, e.g. escalations, churn-reason, arr-impact"),
        account: z.string().optional().describe("The customer this is about, e.g. 'Novaris Holdings'"),
        concepts: z.array(z.string()).optional().describe(`1–3 Wisteria ontology concepts this fact is about, from: ${CONCEPT_NAMES.join(", ")}`),
        new_concept: z
          .object({ name: z.string(), definition: z.string().optional(), parent: z.string().optional() })
          .optional()
          .describe("Only when the fact reveals a recurring business notion the ontology lacks (e.g. a churn driver or a risk pattern): its name, a one-line definition, and its parent concept from the list above."),
      },
      async run({ fact, question, topic, account, concepts: named, new_concept }) {
        const concepts = matchConcepts(named);
        const name = account ?? hooks.account;
        const acct = name ? await resolveAccount(name) : null;
        const id = await teamMemory.remember(a.name, fact, { runId: hooks.runId, account: acct?._id.replace(/^account:/, ""), topic, concepts });
        const q = question?.trim() || `What did the ${a.displayName} learn${acct?.name || name ? ` about ${acct?.name ?? name}` : ""}${topic ? ` (${topic})` : ""}?`;
        await hooks.onRemember?.({ id, fact, question: q, topic, account: acct?.name ?? name, concepts, newConcept: new_concept?.name ? new_concept : undefined });
        return `Saved to team memory as [[${memoryId(id)}]]${concepts.length ? ` (concepts: ${concepts.join(", ")})` : ""}${new_concept?.name ? `; proposed new concept "${new_concept.name}" for the ontology` : ""}.`;
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
