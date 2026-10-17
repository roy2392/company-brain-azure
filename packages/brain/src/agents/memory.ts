import { ObjectId } from "mongodb";
import { cfg } from "../config.ts";
import { memoryDb } from "../brain/store.ts";
import type { Citation } from "../brain/types.ts";

/**
 * The Wisteria agents' shared memory: agent-memory (github.com/mongodb-partners/agent-memory) over REST.
 * agent-memory scopes everything to a user_id; every agent uses the same one (cfg.memory.team), so what one
 * agent learns the others recall. Who wrote a memory is carried in tags: agent:<name>, account:<id>, topic:<t>.
 */
export interface MemoryItem {
  _id: string;
  tier: "stm" | "ltm";
  content: string;
  tags: string[];
  importance: number;
  created_at: string;
  conversation_id: string;
  enrichment_status?: string;
  final_score?: number;
  /** a long-term memory points back at the short-term memory it was promoted from */
  source_stm_id?: string | null;
}

/** The id a memory is known by everywhere (OpenMetadata mirror, citations, the /team feed): its short-term id. */
export const canonicalId = (m: Pick<MemoryItem, "_id" | "source_stm_id">) => String(m.source_stm_id ?? m._id);

export interface ActivityTurn {
  _id?: string;
  agent_name?: string;
  thread_id: string;
  step?: number;
  search_text?: string;
  messages?: Array<{ type: string; content: string; tool_calls?: Array<{ name: string }> }>;
  ts?: string;
  created_at?: string;
}

async function call<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<T> {
  const url = new URL(path, cfg.memory.url);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method,
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`[agent-memory] ${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export const tagValue = (tags: string[], key: string) => tags.find((t) => t.startsWith(`${key}:`))?.slice(key.length + 1);
export const memoryId = (id: string) => `memory:${id}`;

export const teamMemory = {
  team: cfg.memory.team,

  async health() {
    return call<{ status: string }>("GET", "/health");
  },

  /** One self-contained fact, attributed to the agent that learned it. Returns the memory id. */
  async remember(agent: string, fact: string, opts: { runId: string; account?: string; topic?: string; concepts?: string[] }) {
    const tags = [`agent:${agent}`, ...(opts.account ? [`account:${opts.account}`] : []), ...(opts.topic ? [`topic:${opts.topic}`] : []), ...(opts.concepts ?? []).map((c) => `concept:${c}`)];
    const r = await call<{ stm_ids: string[] }>("POST", "/memories", {
      body: { user_id: this.team, conversation_id: `${agent}:${opts.runId}`, messages: [{ message_type: "human", content: fact, tags }] },
    });
    return r.stm_ids[0];
  },

  /** Hybrid recall over the team's memories (vector + full text, importance- and recency-ranked). */
  async recall(query: string, limit = 8): Promise<MemoryItem[]> {
    const r = await call<MemoryItem[] | { results: MemoryItem[] }>("GET", "/memories/recall", { query: { user_id: this.team, query, limit } });
    const hits = Array.isArray(r) ? r : (r?.results ?? []);
    // recall may return the long-term copy; report every memory under its short-term id, once
    const seen = new Set<string>();
    return hits.map((m) => ({ ...m, _id: canonicalId(m) })).filter((m) => !seen.has(m._id) && seen.add(m._id));
  },

  /** Episodic tier: what an agent did (task, tool calls, answer), searchable by every agent. */
  async logActivity(agent: string, threadId: string, messages: unknown[], correlationId?: string) {
    return call("POST", "/activity", { body: { user_id: this.team, thread_id: threadId, messages, agent_name: agent, correlation_id: correlationId } });
  },

  async searchActivity(query: string, opts: { agent?: string; limit?: number } = {}): Promise<ActivityTurn[]> {
    const r = await call<ActivityTurn[] | { results: ActivityTurn[] }>("GET", "/activity/search", { query: { user_id: this.team, query, agent_name: opts.agent, limit: opts.limit ?? 5 } });
    return Array.isArray(r) ? r : (r?.results ?? []);
  },

  /** A memory document straight from Atlas (for get_record and the UI). */
  async get(id: string) {
    const raw = id.replace(/^memory:/, "");
    if (!ObjectId.isValid(raw)) return null;
    return (await memoryDb()).collection("memories").findOne({ _id: new ObjectId(raw) }, { projection: { embedding: 0 } });
  },

  /** Forget the team's memories and activity (demo reset). */
  async reset() {
    const db = await memoryDb();
    const counts = await Promise.all(["memories", "episodes", "decisions", "semantic_cache"].map((c) => db.collection(c).deleteMany({ user_id: this.team })));
    return counts.reduce((n, r) => n + r.deletedCount, 0);
  },
};

export function memoryCitation(m: MemoryItem, agentNames: Record<string, string> = {}): Citation {
  const agent = tagValue(m.tags, "agent") ?? "agent";
  return {
    id: memoryId(m._id),
    source: "memory",
    kind: `${agentNames[agent] ?? agent} memory`,
    title: m.content.length > 110 ? `${m.content.slice(0, 110).trimEnd()}…` : m.content,
    ts: new Date(m.created_at).toISOString(),
    snippet: m.content,
  };
}
