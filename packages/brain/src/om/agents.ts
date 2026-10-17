import { cfg } from "../config.ts";
import { memoryDb } from "../brain/store.ts";
import { AGENTS, agentAppName, type WisteriaAgent } from "../agents/roster.ts";
import { AI_APP, ATLAS_SERVICE, BRAIN_MCP, DATA_PRODUCT, MEMORY_SERVICE, inferColumns, memorySchemaFqn, memoryTableFqn, teamMap, termFqn, tolerate, toOmColumn } from "./catalog.ts";
import { CONCEPTS, GLOSSARY } from "./ontology.ts";
import { OM, ref, type Ref } from "./client.ts";
import { ensureBotToken } from "./mcp.ts";
import type { ColSpec, ColType } from "./schemas.ts";

/**
 * OpenMetadata side of the Wisteria agents: who they are (AI applications), what they may call (MCP servers),
 * where their memory lives (agent_memory collections + lineage), what they did (agent executions)
 * and what they learned (Context Center memories, mirrored from agent-memory on Atlas and authored by each agent's bot).
 */
export const MEMORY_MCP = "agent-memory";
export const MEMORY_TOOLS = new Set(["recall_team_memory", "remember", "team_activity"]);
const MEMORY_PREFIX = "agent-memory-";
const MEMORY_LLM = cfg.memory.llmModel.replace(/[:.]/g, "-");

const c = (name: string, type: ColType, description?: string, extra: Partial<ColSpec> = {}): ColSpec => ({ name, type, description, ...extra });

export const MEMORY_COLLECTIONS: Array<{ name: string; description: string; columns: ColSpec[] }> = [
  {
    name: "memories",
    description: `agent-memory's semantic memory. Short-term memories (tier \`stm\`) and long-term ones (tier \`ltm\`: importance-scored, enriched by a local LLM, merged and decayed). Wisteria's agents share one memory space (\`user_id\` = \`${cfg.memory.team}\`); tags say which agent wrote a memory and about which account. Atlas Vector Search \`memories_vector_index\` + Atlas Search \`memories_fts_index\`, fused with \`$rankFusion\`.`,
    columns: [
      c("_id", "STRING", "Memory id, cited as memory:<id>"),
      c("user_id", "STRING", `Memory space. All Wisteria agents share ${cfg.memory.team}`),
      c("tier", "STRING", "stm (short-term) | ltm (long-term)"),
      c("content", "TEXT", "The remembered fact: self-contained, naming the account and the source records"),
      c("summary", "TEXT", "LLM summary (long memories)"),
      c("tags", "ARRAY", "agent:<name>, account:<id>, topic:<topic>", { arrayOf: "STRING" }),
      c("importance", "DOUBLE", "0–1, scored at enrichment: drives promotion, forgetting and ranking"),
      c("access_count", "BIGINT", "Times recalled (reinforces importance)"),
      c("conversation_id", "STRING", "<agent>:<run id>"),
      c("enrichment_status", "STRING", "pending | complete | failed | not_applicable"),
      c("created_at", "TIMESTAMP"),
      c("expires_at", "TIMESTAMP", "TTL: retention tier decides it"),
      c("embedding", "ARRAY", "Vector (nomic-embed-text, 768d)", { arrayOf: "DOUBLE" }),
    ],
  },
  {
    name: "episodes",
    description: "agent-memory's episodic tier: what each agent actually did. One document per turn with the task, the tool calls and the answer, the agent's name and a correlation id. Searchable by every agent (team_activity).",
    columns: [c("_id", "STRING"), c("user_id", "STRING", "Memory space"), c("agent_name", "STRING", "Which Wisteria agent ran"), c("thread_id", "STRING", "Run id"), c("step", "BIGINT"), c("correlation_id", "STRING", "Claude Agent SDK session id"), c("messages", "JSON", "Task, tool calls and answer"), c("search_text", "TEXT"), c("embedding", "ARRAY", "Vector (nomic-embed-text, 768d)", { arrayOf: "DOUBLE" })],
  },
  {
    name: "decisions",
    description: "agent-memory's sticky decisions: durable key/values the agents should not re-litigate.",
    columns: [c("_id", "STRING"), c("user_id", "STRING", "Memory space"), c("key", "STRING"), c("value", "TEXT"), c("expires_at", "TIMESTAMP")],
  },
];

const AGENT_MEMORY_TOOLS: Array<[string, "Low" | "Medium" | "High", boolean]> = [
  ["store_memory", "Medium", true], ["recall_memory", "Low", false], ["hybrid_search", "Low", false], ["delete_memory", "High", true],
  ["check_cache", "Low", false], ["store_cache", "Low", true], ["cache_invalidate", "Medium", true], ["store_decision", "Medium", true],
  ["recall_decision", "Low", false], ["log_activity", "Low", true], ["search_activity", "Low", false], ["get_thread", "Low", false],
  ["get_correlation", "Low", false], ["set_activity_retention", "High", true], ["memory_health", "Low", false], ["wipe_user_data", "High", true],
];

// ---------------------------------------------------------------------------------------------- identities

const AGENT_POLICY = "WisteriaAgentMemoryPolicy";
const AGENT_ROLE = "WisteriaAgent";
/** the agent's bot user, e.g. support-lead-agent: it authors the agent's Context Center memories */
export const agentBotName = (a: WisteriaAgent) => `${a.name.replace(/_/g, "-")}-agent`;

/** Least privilege for the agents: read the catalog (Data Consumer) and write memories, nothing else (no delete). */
async function ensureAgentRole(om: OM) {
  await om.put("/policies", {
    name: AGENT_POLICY,
    displayName: "Wisteria agent memory",
    description: "Lets Wisteria's agents create and update Context Center memories. No delete, nothing else.",
    rules: [
      { name: "WriteContextMemories", resources: ["contextMemory"], operations: ["Create", "ViewAll", "EditAll", "EditDescription", "EditDisplayName", "EditOwners", "EditTags"], effect: "allow" },
      // agents may propose glossary terms; reviewers (Data Platform) approve them
      { name: "ProposeGlossaryTerms", resources: ["glossaryTerm"], operations: ["Create", "ViewAll", "EditDescription", "EditDisplayName"], effect: "allow" },
    ],
  });
  await om.put("/roles", { name: AGENT_ROLE, displayName: "Wisteria agent", description: "Wisteria role agents: read the catalog, write their own memories.", policies: ["DataConsumerPolicy", AGENT_POLICY] });
}

const agentTokens = new Map<string, string>();
/** JWT of the agent's own bot (created on first use): read the catalog, write memories. */
export async function agentToken(om: OM, a: WisteriaAgent): Promise<string> {
  if (!agentTokens.has(a.name)) {
    await ensureAgentRole(om);
    agentTokens.set(a.name, await ensureBotToken(om, { name: agentBotName(a), displayName: a.displayName, description: `Bot identity of the Wisteria ${a.displayName}: it authors the agent's memories in the Context Center and reads the catalog over MCP.`, roles: [AGENT_ROLE] }));
  }
  return agentTokens.get(a.name)!;
}

/** An OpenMetadata client that acts as the agent's own bot. */
export async function agentClient(om: OM, a: WisteriaAgent): Promise<OM> {
  return new OM(await agentToken(om, a));
}

export async function setupAgentAssets(om: OM, brainSchemaFqn: string, log = console.log) {
  const teams = await teamMap(om);
  const owners = [teams.DataPlatform];
  const domains = ["CompanyBrain"];

  // where the memory lives: agent-memory's collections, on their own Atlas cluster or next to the brain
  const schemaFqn = await memorySchemaFqn(om, owners);
  // moved to the Atlas cluster: drop the old Atlas Local entry (and its lineage) so the catalog has one memory
  if (MEMORY_SERVICE !== ATLAS_SERVICE) await tolerate(om.req("DELETE", `/databaseSchemas/name/${encodeURIComponent(`${ATLAS_SERVICE}.default.${cfg.memory.db}`)}?recursive=true&hardDelete=true`), [400, 404]);
  const db = await memoryDb();
  const tables: Record<string, Ref> = {};
  for (const t of MEMORY_COLLECTIONS) {
    const samples = await db.collection(t.name).find({}, { projection: { embedding: 0 } }).limit(100).toArray();
    const existing = await om.byName("tables", `${schemaFqn}.${t.name}`, "columns");
    const columns = existing?.columns?.length ? existing.columns.map(({ fullyQualifiedName, ...col }: any) => ({ ...col, description: col.description ?? t.columns.find((s) => s.name === col.name)?.description })) : inferColumns(samples as any, t.columns);
    if (!columns.some((col: any) => col.name === "embedding") && t.columns.some((s) => s.name === "embedding")) columns.push(toOmColumn("embedding", { dataType: "ARRAY", arrayDataType: "DOUBLE" }, t.columns.find((s) => s.name === "embedding")));
    tables[t.name] = ref(await om.put("/tables", { name: t.name, databaseSchema: schemaFqn, description: t.description, tableType: "Regular", columns, owners, domains, dataProducts: [DATA_PRODUCT] }), "table");
  }

  // the memory service, as an MCP server, and the local model that enriches memories
  await om.put("/llmModels", { name: MEMORY_LLM, displayName: cfg.memory.llmModel, service: "ollama_local", baseModel: cfg.memory.llmModel, modelProvider: "Alibaba Cloud", description: "Local LLM inside agent-memory: summarizes and merges long-term memories (importance is scored in-process).", governanceStatus: "Approved", owners, domains });
  const memMcp = await om.put("/mcpServers", {
    name: MEMORY_MCP, displayName: "agent-memory (MongoDB)", service: "wisteria_mcp", serverType: "Database", transportType: "StreamableHTTP", developmentStage: "Development", owners, domains,
    description: `Shared memory for Wisteria's agents: github.com/mongodb-partners/agent-memory on ${cfg.memory.uri ? "its own MongoDB Atlas cluster on Azure" : "the brain's MongoDB Atlas"} (database \`${cfg.memory.db}\`). Four tiers: short-term, long-term (importance-scored, enriched by ${cfg.memory.llmModel} on Ollama), episodic (what each agent did) and a semantic cache. REST at ${cfg.memory.url}, MCP at ${cfg.memory.url}/mcp. The agents reach it through recall_team_memory / remember / team_activity.`,
    connectionConfig: { url: `${cfg.memory.url}/mcp` },
    tools: AGENT_MEMORY_TOOLS.map(([name, riskLevel, sideEffects]) => ({ name, toolCategory: "DataOperation", riskLevel, sideEffects, idempotent: !sideEffects, reversible: riskLevel !== "High" })),
    dataAccessSummary: { sensitivityLevel: "Confidential", piiAccess: false, databaseAccess: true, externalApiAccess: false, networkAccess: true, fileSystemAccess: false },
  });

  // the agents
  const brainTable = async (n: string) => ref(await om.get(`/tables/name/${encodeURIComponent(`${brainSchemaFqn}.${n}`)}`), "table");
  const [docs, chunks, entities] = await Promise.all(["docs", "chunks", "entities"].map(brainTable));
  const brainMcp = ref(await om.get(`/mcpServers/name/wisteria_mcp.${BRAIN_MCP}`), "mcpServer");
  const claude = await om.byName("llmModels", `anthropic.${cfg.agent.model}`);
  const embed = await om.byName("llmModels", `ollama_local.${cfg.embed.ollamaModel}`);
  const apps: Ref[] = [];
  for (const a of AGENTS) {
    const app = await om.put("/aiApplications", {
      name: agentAppName(a), displayName: a.displayName, applicationType: "Agent", developmentStage: "Development",
      owners: [teams[a.team]], domains, dataProducts: [DATA_PRODUCT],
      description: `${a.role}\n\nOne of three Wisteria agents that share a single memory: agent-memory on MongoDB Atlas, space \`${cfg.memory.team}\`. It recalls the team's memory before it works and saves what it learns back; its runs are recorded here as agent executions and its memories are mirrored into the Context Center. Brain tools: ${a.tools.join(", ")}.`,
      primaryModel: cfg.agent.model,
      modelConfigurations: [...(claude ? [{ model: ref(claude, "llmModel"), purpose: "Primary" }] : []), ...(embed ? [{ model: ref(embed, "llmModel"), purpose: "Embedding" }] : [])],
      tools: [brainMcp, ref(memMcp, "mcpServer")],
      dataSources: [docs, entities],
      knowledgeBases: [chunks, tables.memories],
      framework: { name: "Custom", language: "TypeScript" },
      sourceCode: "packages/brain/src/agents/run.ts",
    });
    apps.push(ref(app, "aiApplication"));
  }

  // lineage: brain → agents → shared memory → the brain chat agent
  let edges = 0;
  const edge = async (from: Ref, to: Ref, why: string) => {
    if (await tolerate(om.addLineage(from, to, why))) edges++;
  };
  for (const app of apps) {
    for (const t of [docs, chunks, entities]) await edge(t, app, "retrieved by the agent (brain tools)");
    await edge(app, tables.memories, "remember: findings saved to the team's shared memory");
    await edge(app, tables.episodes, "every run logged to the episodic tier");
  }
  const brainApp = await om.byName("aiApplications", AI_APP);
  if (brainApp) await edge(tables.memories, ref(brainApp, "aiApplication"), "team_memory: the brain recalls what the agents learned");
  for (const a of AGENTS) await agentClient(om, a);
  log(`  ✓ agent memory: ${MEMORY_COLLECTIONS.length} collections in ${schemaFqn}, MCP server ${MEMORY_MCP}, ${AGENTS.length} AI applications with bot users (role ${AGENT_ROLE}), ${edges} lineage edges`);
}

// ---------------------------------------------------------------------------------------------- runtime

const refCache = new Map<string, Ref | null>();
async function cached(om: OM, key: string, load: () => Promise<any>): Promise<Ref | null> {
  if (!refCache.has(key)) {
    const e = await load().catch(() => null);
    refCache.set(key, e ? ref(e, key.split(":")[0]) : null);
  }
  return refCache.get(key)!;
}
const memoryTable = (om: OM, name: string) => cached(om, `table:${name}`, () => om.get(`/tables/name/${encodeURIComponent(memoryTableFqn(name))}`));
const brainTableRef = (om: OM, name: string) => cached(om, `table:brain.${name}`, () => om.get(`/tables/name/${encodeURIComponent(`wisteria_atlas.default.${cfg.mongo.db}.${name}`)}`));
const appRef = (om: OM, a: WisteriaAgent) => cached(om, `aiApplication:${a.name}`, () => om.get(`/aiApplications/name/${agentAppName(a)}`));
const mcpRef = (om: OM, name: string) => cached(om, `mcpServer:${name}`, () => om.get(`/mcpServers/name/wisteria_mcp.${name}`));

export interface RunRecord {
  runId: string;
  task: string;
  answer: string;
  startedAt: number;
  endedAt: number;
  toolCalls: Array<{ name: string; input: unknown; ok: boolean; at: number; ms?: number }>;
  costUsd?: number;
  sessionId?: string;
  error?: string;
}

/** One agent run → an OpenMetadata agent execution (tool calls, data read and written, cost). */
export async function recordExecution(om: OM, a: WisteriaAgent, run: RunRecord) {
  const app = await appRef(om, a);
  if (!app) return null;
  const [brainMcp, memMcp] = await Promise.all([mcpRef(om, BRAIN_MCP), mcpRef(om, MEMORY_MCP)]);
  const claude = await cached(om, `llmModel:${cfg.agent.model}`, () => om.get(`/llmModels/name/${encodeURIComponent(`anthropic.${cfg.agent.model}`)}`));
  const used = new Set(run.toolCalls.map((t) => t.name));
  const access: Array<[Ref | null, "Read" | "Write"]> = [];
  if (run.toolCalls.some((t) => !MEMORY_TOOLS.has(t.name))) access.push([await brainTableRef(om, "docs"), "Read"], [await brainTableRef(om, "entities"), "Read"]);
  if (used.has("search_brain")) access.push([await brainTableRef(om, "chunks"), "Read"]);
  if (used.has("recall_team_memory")) access.push([await memoryTable(om, "memories"), "Read"]);
  if (used.has("remember")) access.push([await memoryTable(om, "memories"), "Write"]);
  access.push([await memoryTable(om, "episodes"), "Write"]);
  return om.req("POST", "/agentExecutions", {
    agent: app,
    agentId: app.id,
    timestamp: run.startedAt,
    endTimestamp: run.endedAt,
    status: run.error ? "Failed" : "Success",
    input: run.task,
    output: run.answer.slice(0, 8000),
    ...(run.error ? { errorMessage: run.error } : {}),
    toolCalls: run.toolCalls.map((t) => ({ tool: (MEMORY_TOOLS.has(t.name) ? memMcp : brainMcp) ?? undefined, parameters: { tool: t.name, ...(t.input as object) }, success: t.ok, timestamp: t.at, ...(t.ms ? { latencyMs: t.ms } : {}) })),
    dataAccessed: access.filter(([r]) => r).map(([r, accessType]) => ({ dataSource: r, accessType, timestamp: run.endedAt })),
    // cost goes on the model call: OpenMetadata 2.0.5 rejects metrics.cost
    modelCalls: claude ? [{ model: claude, purpose: "Primary", timestamp: run.endedAt, ...(run.costUsd ? { cost: run.costUsd } : {}) }] : [],
    sessionId: run.sessionId,
    executedBy: a.name,
    environment: "Development",
    agentVersion: "1.0",
  });
}

// ---------------------------------------------------------------------------------------------- ontology from memory

const conceptKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const CONCEPT_BY_KEY = new Map(CONCEPTS.map((c) => [conceptKey(c.name), c.name]));
for (const c of CONCEPTS) CONCEPT_BY_KEY.set(conceptKey(c.displayName), c.name);
export const CONCEPT_NAMES = CONCEPTS.map((c) => c.name);

/** Ontology concepts an agent named, mapped onto the Wisteria glossary (unknown names are dropped). */
export function matchConcepts(names: string[] = []): string[] {
  return [...new Set(names.map((n) => CONCEPT_BY_KEY.get(conceptKey(n))).filter(Boolean) as string[])].slice(0, 3);
}

export interface NewConcept {
  name: string;
  definition?: string;
  parent?: string;
}

/**
 * A business notion an agent learned that the ontology lacks → a glossary term under its parent concept, created by
 * the agent's bot, owned by its team, reviewed by Data Platform (OpenMetadata puts it In Review), related to the
 * concepts it touches. The memory is tagged with it. (derivedEntities/usageCount are server-managed in 2.0.5.)
 */
async function deriveTerm(om: OM, a: WisteriaAgent, nc: NewConcept, related: string[], memoryId: string): Promise<(Ref & { fullyQualifiedName?: string }) | null> {
  const display = nc.name.replace(/[^\p{L}\p{N} &-]/gu, "").trim();
  const name = display.split(/[\s&-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
  if (!name || CONCEPT_BY_KEY.has(conceptKey(name))) return null;
  const parent = matchConcepts([nc.parent ?? ""])[0] ?? related[0];
  const parentFqn = parent ? termFqn(parent) : undefined;
  const fqn = `${parentFqn ?? GLOSSARY}.${name}`;
  const existing = await om.byName<any>("glossaryTerms", fqn).catch(() => null);
  if (existing) return ref(existing, "glossaryTerm");
  const teams = await teamMap(om);
  const body = {
    glossary: GLOSSARY,
    ...(parentFqn ? { parent: parentFqn } : {}),
    name,
    displayName: display,
    description: `${nc.definition?.trim() || display}\n\nProposed by the ${a.displayName} from team memory \`${memoryId}\` (agent-memory on MongoDB Atlas) on ${new Date().toISOString().slice(0, 10)}. Pending review by Data Platform.`,
    owners: [teams[a.team]],
    reviewers: [teams.DataPlatform],
  };
  let term: any;
  try {
    term = await (await agentClient(om, a)).put("/glossaryTerms", body);
  } catch {
    term = await om.put("/glossaryTerms", body); // the agent's bot may lack permission on older setups
  }
  // typed links to the concepts the memory touched (same relation API as the ontology setup)
  for (const r of related.filter((x) => x !== parent)) {
    const other = await om.byName<any>("glossaryTerms", termFqn(r)).catch(() => null);
    if (other) await tolerate(om.req("POST", `/glossaryTerms/${term.id}/relations`, { relationType: "relatedTo", term: { id: other.id, type: "glossaryTerm" } }));
  }
  return { ...ref(term, "glossaryTerm"), fullyQualifiedName: term.fullyQualifiedName };
}

/** A memory an agent saved → a shared, entity-scoped Context Center memory (agent-memory on Atlas stays the record). */
export async function promoteMemory(om: OM, a: WisteriaAgent, m: { id: string; fact: string; question: string; account?: string; topic?: string; runId: string; concepts?: string[]; newConcept?: NewConcept }) {
  const app = await appRef(om, a);
  if (!app) return null;
  const teams = await teamMap(om);
  const others = (await Promise.all(AGENTS.filter((x) => x.name !== a.name).map((x) => appRef(om, x)))).filter(Boolean) as Ref[];
  const table = await memoryTable(om, "memories");
  const title = m.question.length > 120 ? `${m.question.slice(0, 117)}…` : m.question;
  const concepts = matchConcepts(m.concepts);
  // the ontology grows from memory: a proposed concept becomes a glossary term (in review) and tags this memory
  const derived = m.newConcept?.name ? await deriveTerm(om, a, m.newConcept, concepts, m.id).catch(() => null) : null;
  const tags = [...concepts.map(termFqn), ...(derived?.fullyQualifiedName ? [derived.fullyQualifiedName] : [])];
  // written by the agent's own bot, so OpenMetadata shows the agent as the author
  const memory = await (await agentClient(om, a)).put("/contextCenter/memories", {
    name: `${MEMORY_PREFIX}${m.id}`,
    displayName: title,
    title,
    question: m.question,
    answer: m.fact,
    memoryType: "Note",
    memoryScope: "EntityScoped",
    status: "Active",
    sourceType: "RememberRequest",
    primaryEntity: app,
    relatedEntities: [...(table ? [table] : []), ...others],
    shareConfig: { visibility: "Shared", sharedWith: [...new Set(AGENTS.map((x) => x.team))].map((t) => ({ principal: teams[t], role: "Viewer" })) },
    owners: [teams[a.team]],
    description: `Written by the ${a.displayName} on ${new Date().toISOString().slice(0, 10)}${m.account ? ` about ${m.account}` : ""}${m.topic ? ` (${m.topic})` : ""}. Memory of record: MongoDB Atlas \`${cfg.memory.db}.memories\` _id \`${m.id}\`, agent-memory space \`${cfg.memory.team}\`, run \`${a.name}:${m.runId}\`.`,
    tags: tags.map((fqn) => ({ tagFQN: fqn, source: "Glossary", labelType: "Manual", state: "Confirmed" })),
  });
  return memory;
}

/** Glossary terms the agents proposed from memory (deriveTerm marks them in the description), newest first. */
export async function derivedTerms(om: OM) {
  const r = await om.get<any>(`/glossaryTerms?limit=1000&fields=owners,reviewers,parent`);
  return ((r.data ?? []) as any[])
    // OpenMetadata stores the backtick as &#96;
    .filter((t) => /from team memory (`|&#96;)/.test(String(t.description ?? "")))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** Demo reset: remove the glossary terms the agents proposed. */
export async function forgetDerivedTerms(om: OM) {
  let n = 0;
  for (const t of await derivedTerms(om)) if (await tolerate(om.req("DELETE", `/glossaryTerms/${t.id}?hardDelete=true&recursive=true`), [400, 404])) n++;
  return n;
}

/** Demo reset: remove the Context Center mirror of the agents' memories. */
export async function forgetPromotedMemories(om: OM) {
  const r = await om.get<any>("/contextCenter/memories?limit=1000");
  let n = 0;
  for (const m of r.data ?? []) if (String(m.name).startsWith(MEMORY_PREFIX) && (await tolerate(om.req("DELETE", `/contextCenter/memories/${m.id}?hardDelete=true`), [400, 404]))) n++;
  return n;
}
