import { z } from "zod";
import { OM } from "../om/client.ts";
import { GLOSSARY } from "../om/ontology.ts";
import { findEntities, searchChunks } from "./search.ts";
import { brainNow, colls } from "./store.ts";
import { SOURCES, type BrainDoc, type Citation, type Entity, type Source } from "./types.ts";
import { memoryCitation, tagValue, teamMemory } from "../agents/memory.ts";
import { AGENT_NAMES } from "../agents/roster.ts";

/**
 * The brain's tool surface. Defined once, exposed twice: as an MCP server (Claude Desktop/Code)
 * and as in-process tools for the web agent. Every result carries citations the UI can render.
 */
export interface ToolResult {
  text: string;
  citations: Citation[];
  data?: unknown;
}

export interface BrainTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  run(args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}

const define = <S extends z.ZodRawShape>(t: BrainTool<S>) => t;
const DAY = 86_400_000;
const LABEL: Record<string, string> = {
  salesforce: "Salesforce",
  zendesk: "Zendesk",
  gong: "Gong",
  slack: "Slack",
  jira: "Jira",
  confluence: "Confluence",
  drive: "Google Drive",
  openmetadata: "OpenMetadata",
  memory: "Team memory",
};

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
/** Tool inputs are lenient (agents sometimes pass 25 or "jira "): clamp here instead of failing validation. */
const clamp = (v: number | undefined, lo: number, hi: number, d: number) => (v === undefined || !Number.isFinite(v) ? d : Math.min(hi, Math.max(lo, Math.round(v))));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

export function cite(d: Pick<BrainDoc, "_id" | "source" | "kind" | "title" | "url" | "ts">, snippet?: string): Citation {
  return { id: d._id, source: d.source, kind: d.kind, title: d.title, url: d.url, ts: new Date(d.ts).toISOString(), snippet };
}

const line = (c: Citation) => `[[${c.id}]] ${LABEL[c.source]} ${c.kind} · ${day(c.ts)} · "${clip(c.title, 90)}"${c.snippet ? `\n    ${clip(c.snippet.replace(/\s+/g, " "), 320)}` : ""}`;

/** "Acacia", "acacia-partners", "account:acacia-partners" → the account entity. */
export async function resolveAccount(nameOrId: string): Promise<Entity | null> {
  const { entities } = await colls();
  if (nameOrId.startsWith("account:")) return entities.findOne({ _id: nameOrId });
  const [best] = await findEntities(nameOrId, "account", 1);
  return best ? ((await entities.findOne({ _id: best._id })) as Entity | null) : null;
}

const notFound = (what: string): ToolResult => ({ text: `No account matching "${what}" in the brain.`, citations: [] });

// ------------------------------------------------------------------------------------------------

const searchBrain = define({
  name: "search_brain",
  description:
    "Hybrid semantic + keyword search (MongoDB Atlas $rankFusion) over everything Wisteria knows: Salesforce, Zendesk tickets, Gong call transcripts, Slack threads, Jira issues, Confluence pages, Drive docs. Returns cited passages.",
  shape: {
    query: z.string().describe("What to look for, in natural language"),
    account: z.string().optional().describe("Restrict to one customer account (name or account id)"),
    sources: z.array(z.string()).optional().describe(`Restrict to these systems: ${SOURCES.join(", ")}`),
    since_days: z.number().optional().describe("Only content from the last N days"),
    limit: z.number().optional().describe("Passages to return, 1–20 (default 8)"),
  },
  async run({ query, account, sources: requested, since_days, limit }) {
    const sources = requested?.map((x) => x.trim().toLowerCase()).filter((x): x is Source => (SOURCES as readonly string[]).includes(x));
    const acct = account ? await resolveAccount(account) : null;
    if (account && !acct) return notFound(account);
    const since = since_days && since_days > 0 ? new Date((await brainNow()).getTime() - since_days * DAY) : undefined;
    const { hits, mode } = await searchChunks({ query, accountIds: acct ? [acct._id] : undefined, sources: sources?.length ? sources : undefined, since, limit: clamp(limit, 1, 20, 8) });
    const seen = new Set<string>();
    const citations = hits.filter((h) => !seen.has(h.docId) && seen.add(h.docId)).map((h) => cite({ ...h, _id: h.docId }, h.text));
    const scope = [acct && `account ${acct.name}`, sources?.length && sources.join("/"), since_days && `last ${since_days}d`].filter(Boolean).join(", ");
    return {
      text: citations.length ? `${citations.length} results (${mode}${scope ? `; ${scope}` : ""}):\n${citations.map(line).join("\n")}` : `No results for "${query}"${scope ? ` (${scope})` : ""}.`,
      citations,
      data: { mode },
    };
  },
});

const account360 = define({
  name: "account_360",
  description:
    "Everything about one customer account in one call: CRM facts (type, industry, owner, ARR, open opportunities, contracts), support load and escalations, recent Gong calls, Slack channels, Jira issues, key people and the latest activity — each item cited.",
  shape: { account: z.string().describe("Account name or id, e.g. 'Acacia Partners'") },
  async run({ account }) {
    const acct = await resolveAccount(account);
    if (!acct) return notFound(account);
    const { docs, entities } = await colls();
    const now = await brainNow();
    const since90 = new Date(now.getTime() - 90 * DAY);
    const all = await docs.find({ accountIds: acct._id }, { projection: { text: 0 } }).sort({ ts: -1 }).limit(2000).toArray();
    const by = (src: Source, kind?: string) => all.filter((d) => d.source === src && (!kind || d.kind === kind));
    const counts = Object.fromEntries(SOURCES.map((s) => [s, { total: by(s).length, last90: by(s).filter((d) => d.ts >= since90).length }]));

    const opps = all.filter((d) => d.kind === "opportunity");
    const open = opps.filter((o) => !o.meta.isClosed);
    const won = opps.filter((o) => o.meta.isWon);
    const sum = (xs: BrainDoc[]) => xs.reduce((a, o) => a + (Number(o.meta.amount) || 0), 0);
    // Era mirrors Zendesk tickets as Salesforce cases: count support once (Zendesk when present)
    const zdTickets = all.filter((d) => d.kind === "ticket");
    const tickets = zdTickets.length ? zdTickets : all.filter((d) => d.kind === "case");
    const openTickets = tickets.filter((t) => !/closed|solved|resolved/i.test(String(t.meta.status ?? "")));
    const escalations = tickets.filter((t) => t.ts >= since90 && (t.meta.escalated || /urgent|high|critical/i.test(String(t.meta.priority ?? ""))));
    const events = all.filter((d) => d.kind === "account-event");
    const a0 = acct.attrs as Record<string, any>;
    // what every system recorded around a churn record (±3 days): decisions are often in Slack or the CRM
    const churnAt = a0.churnedAt ? new Date(a0.churnedAt).getTime() : null;
    const near = churnAt
      ? all
          .filter((d) => Math.abs(d.ts.getTime() - churnAt) <= 3 * DAY && d.kind !== "account-event")
          // decisions live in conversations, calls and deals more than in tickets
          .map((d) => ({ d, rank: Math.abs(d.ts.getTime() - churnAt) + (/ticket|case|task/.test(d.kind) ? 2 * DAY : 0) }))
          .sort((x, y) => x.rank - y.rank)
          .slice(0, 8)
          .map((x) => x.d)
      : [];
    const nearText = new Map((await docs.find({ _id: { $in: near.map((d) => d._id) } }, { projection: { text: 1 } }).toArray()).map((d) => [d._id, d.text]));
    const record = all.find((d) => d.kind === "account-record");
    const calls = by("gong", "call").slice(0, 5);
    const issues = all.filter((d) => d.source === "jira").slice(0, 5);
    const people = await entities.find({ "links.to": acct._id, type: "person" }, { projection: { name: 1, attrs: 1, links: 1 } }).limit(25).toArray();

    const highlight = [...(record ? [record] : []), ...events.slice(0, 3), ...near, ...open.slice(0, 5), ...escalations.slice(0, 5), ...calls, ...issues, ...all.slice(0, 8)];
    const citations = [...new Map(highlight.map((d) => [d._id, cite(d, nearText.get(d._id))])).values()];
    const fmt$ = (n: number) => (n ? `$${Math.round(n).toLocaleString("en-US")}` : "—");
    const a = acct.attrs as Record<string, any>;
    const data = {
      account: { id: acct._id, name: acct.name, ...a, sources: acct.sources },
      commercial: { openPipeline: sum(open), openOpportunities: open.length, closedWon: sum(won), closedWon12m: a.closedWon12m ?? null, arr: a.arr ?? null, renewalDate: a.renewalDate ?? null, seats: a.seats ?? null, churnedAt: a.churnedAt ?? null },
      support: { open: openTickets.length, escalations: escalations.length, last90: tickets.filter((t) => t.ts >= since90).length },
      activity: counts,
      people: people.map((p) => ({ id: p._id, name: p.name, title: p.attrs?.title, rel: p.links?.find((l: any) => l.to === acct._id)?.rel })),
      lastActivity: all[0]?.ts ?? null,
    };
    const text = [
      `${acct.name} (${acct._id}) — ${[a.type, a.industry, a.region].filter(Boolean).join(" · ") || "account"}${a.owner ? ` · owner ${a.owner}` : ""}`,
      a.churnedAt ? `CHURN RECORDED on ${a.churnedAt} (Zendesk organization audit log). Records from every system within 3 days of it are listed first under Evidence.` : "",
      `Commercial: ARR ${fmt$(a.arr)} (Zendesk account record${record ? ` [[${record._id}]]` : ""}${a.seats ? `, ${a.seats} seats` : ""}${a.renewalDate ? `, renewal ${a.renewalDate}` : ""}) · open pipeline ${fmt$(data.commercial.openPipeline)} across ${open.length} open opps · closed-won last 12 months ${fmt$(a.closedWon12m)}`,
      `Support: ${openTickets.length} open tickets, ${escalations.length} urgent/high or escalated in the last 90d, ${data.support.last90} tickets in the last 90d`,
      `Activity last 90d: ${SOURCES.filter((s) => counts[s].last90).map((s) => `${LABEL[s]} ${counts[s].last90}`).join(", ") || "none"}`,
      people.length ? `People: ${people.slice(0, 10).map((p) => `${p.name}${p.attrs?.title ? ` (${p.attrs.title})` : ""}`).join("; ")}` : "",
      a.slackChannels?.length ? `Slack: ${a.slackChannels.map((c: string) => `#${c}`).join(", ")}` : "",
      `Brain "today": ${day(now)}`,
      "Evidence:",
      ...citations.map(line),
    ].filter(Boolean);
    return { text: text.join("\n"), citations, data };
  },
});

const relatedEntities = define({
  name: "related_entities",
  description: "Walk the company graph ($graphLookup) around an account, person or product: contacts, owners, products used, linked accounts.",
  shape: {
    entity: z.string().describe("Entity id (account:…, person:…, product:…) or an account name"),
    depth: z.number().optional().describe("Graph hops, 1–3 (default 1)"),
  },
  async run({ entity, depth }) {
    const { entities } = await colls();
    const start = entity.includes(":") ? await entities.findOne({ _id: entity }) : await resolveAccount(entity);
    if (!start) return { text: `No entity "${entity}".`, citations: [] };
    const [g] = await entities
      .aggregate([
        { $match: { _id: start._id } },
        { $graphLookup: { from: "entities", startWith: "$links.to", connectFromField: "links.to", connectToField: "_id", as: "out", maxDepth: clamp(depth, 1, 3, 1) - 1, depthField: "hop" } },
        { $lookup: { from: "entities", localField: "_id", foreignField: "links.to", as: "in", pipeline: [{ $project: { name: 1, type: 1, attrs: 1, links: 1 } }, { $limit: 50 }] } },
        { $project: { "out.links": 0 } },
      ])
      .toArray();
    const outgoing = (start.links ?? []).map((l: any) => ({ ...l, node: g?.out?.find((o: any) => o._id === l.to) }));
    const incoming = (g?.in ?? []).map((n: any) => ({ node: n, rel: n.links?.find((l: any) => l.to === start._id)?.rel }));
    const nodes = [
      ...outgoing.map((o: any) => ({ id: o.to, name: o.node?.name ?? o.to, type: o.node?.type, rel: o.rel, dir: "out" })),
      ...incoming.map((i: any) => ({ id: i.node._id, name: i.node.name, type: i.node.type, title: i.node.attrs?.title, rel: i.rel, dir: "in" })),
    ];
    return {
      text: `${start.name} (${start._id}) — ${nodes.length} connections:\n${nodes.map((n) => `  ${n.dir === "out" ? "→" : "←"} ${n.rel ?? "related"} ${n.name} (${n.id})${(n as any).title ? `, ${(n as any).title}` : ""}`).join("\n")}`,
      citations: [],
      data: { center: { id: start._id, name: start.name, type: start.type }, nodes },
    };
  },
});

const whatChanged = define({
  name: "what_changed",
  description:
    "What changed in the last N days (default 91 = one quarter) versus the period before — across every system, for one account or the whole company. Highlights deals that moved, new escalations, calls and the accounts with the biggest activity swings.",
  shape: {
    account: z.string().optional().describe("Account name or id; omit for company-wide"),
    days: z.number().optional().describe("Window in days, 7–365 (default 91)"),
  },
  async run({ account, days }) {
    const n = clamp(days, 7, 365, 91);
    const acct = account ? await resolveAccount(account) : null;
    if (account && !acct) return notFound(account);
    const { docs } = await colls();
    const now = await brainNow();
    const cur = new Date(now.getTime() - n * DAY);
    const prev = new Date(cur.getTime() - n * DAY);
    const match = { ...(acct ? { accountIds: acct._id } : {}), ts: { $gte: prev } };
    const [agg] = await docs
      .aggregate([
        { $match: match },
        { $set: { period: { $cond: [{ $gte: ["$ts", cur] }, "current", "previous"] } } },
        {
          $facet: {
            bySource: [{ $group: { _id: { source: "$source", kind: "$kind", period: "$period" }, n: { $sum: 1 } } }],
            byAccount: acct
              ? []
              : [
                  { $unwind: "$accountIds" },
                  { $group: { _id: "$accountIds", current: { $sum: { $cond: [{ $eq: ["$period", "current"] }, 1, 0] } }, previous: { $sum: { $cond: [{ $eq: ["$period", "previous"] }, 1, 0] } } } },
                  { $set: { delta: { $subtract: ["$current", "$previous"] } } },
                  { $sort: { delta: -1 } },
                  { $limit: 8 },
                ],
            notable: [
              { $match: { period: "current", $or: [{ kind: "opportunity" }, { "meta.escalated": true }, { "meta.priority": { $regex: "urgent|high|critical", $options: "i" } }, { kind: "call" }] } },
              { $sort: { ts: -1 } },
              { $limit: 15 },
              { $project: { text: 0 } },
            ],
          },
        },
      ])
      .toArray();
    const rows = new Map<string, { current: number; previous: number }>();
    for (const r of agg?.bySource ?? []) {
      const k = `${r._id.source}/${r._id.kind}`;
      const v = rows.get(k) ?? { current: 0, previous: 0 };
      v[r._id.period as "current" | "previous"] += r.n;
      rows.set(k, v);
    }
    const table = [...rows.entries()].sort((a, b) => b[1].current - a[1].current);
    const citations = (agg?.notable ?? []).map((d: BrainDoc) => cite(d));
    const { entities } = await colls();
    const names = new Map((await entities.find({ _id: { $in: (agg?.byAccount ?? []).map((a: any) => a._id) } }, { projection: { name: 1 } }).toArray()).map((e) => [e._id, e.name]));
    const text = [
      `What changed ${acct ? `for ${acct.name}` : "at Wisteria"}: ${day(cur)} → ${day(now)} vs the ${n} days before.`,
      ...table.map(([k, v]) => `  ${k}: ${v.current} (prev ${v.previous}, ${v.current - v.previous >= 0 ? "+" : ""}${v.current - v.previous})`),
      ...(agg?.byAccount?.length ? ["Biggest activity swings:", ...agg.byAccount.map((a: any) => `  ${names.get(a._id) ?? a._id}: ${a.current} (prev ${a.previous})`)] : []),
      "Notable this period:",
      ...citations.map(line),
    ];
    return { text: text.join("\n"), citations, data: { window: { from: cur, to: now }, bySource: Object.fromEntries(table), swings: agg?.byAccount ?? [] } };
  },
});

const explainData = define({
  name: "explain_data",
  description:
    "Ask the catalog (OpenMetadata): the governed definition of a business term or metric (ARR, churn risk, escalation…), who owns it, which systems/columns carry it and the lineage from source systems into the brain. Use before quoting any metric.",
  shape: { term: z.string().describe("Business term, metric or dataset name") },
  async run({ term }) {
    const om = new OM();
    try {
      const res = await om.search(term, "glossary_term_search_index", 3);
      const hit = res.hits?.hits?.[0]?._source;
      const citations: Citation[] = [];
      const out: string[] = [];
      if (hit) {
        const t = await om.byName("glossaryTerms", hit.fullyQualifiedName, "owners,relatedTerms,synonyms,domains,reviewers");
        const tagged = await om.search(`tags.tagFQN:"${hit.fullyQualifiedName}" OR columns.tags.tagFQN:"${hit.fullyQualifiedName}"`, "table_search_index", 10);
        const tables = (tagged.hits?.hits ?? []).map((h: any) => h._source);
        citations.push({ id: `om:glossaryTerm:${t.fullyQualifiedName}`, source: "openmetadata", kind: "glossary term", title: t.displayName ?? t.name, url: om.url("glossaryTerm", t.fullyQualifiedName), ts: new Date(t.updatedAt ?? Date.now()).toISOString() });
        out.push(
          `[[om:glossaryTerm:${t.fullyQualifiedName}]] ${t.displayName ?? t.name} — ${t.description}`,
          `Owner: ${(t.owners ?? []).map((o: any) => o.displayName ?? o.name).join(", ") || "unassigned"} · Domain: ${(t.domains ?? []).map((d: any) => d.displayName ?? d.name).join(", ") || "—"}`,
          t.synonyms?.length ? `Synonyms: ${t.synonyms.join(", ")}` : "",
          t.relatedTerms?.length ? `Related: ${t.relatedTerms.map((r: any) => r.displayName ?? r.name).join(", ")}` : "",
        );
        for (const tb of tables.slice(0, 5)) {
          const lin = await om.lineage("table", tb.fullyQualifiedName, 2, 1).catch(() => null);
          const upstream = (lin?.nodes ?? []).filter((n: any) => n.fullyQualifiedName !== tb.fullyQualifiedName).map((n: any) => n.fullyQualifiedName);
          citations.push({ id: `om:table:${tb.fullyQualifiedName}`, source: "openmetadata", kind: "dataset", title: tb.fullyQualifiedName, url: om.url("table", tb.fullyQualifiedName), ts: new Date(tb.updatedAt ?? Date.now()).toISOString() });
          out.push(`Carried by [[om:table:${tb.fullyQualifiedName}]]${upstream.length ? ` ← lineage: ${upstream.slice(0, 4).join(", ")}` : ""}`);
        }
      } else {
        const ds = await om.search(term, "table_search_index", 5);
        const tables = (ds.hits?.hits ?? []).map((h: any) => h._source);
        if (!tables.length) return { text: `OpenMetadata has no glossary term or dataset matching "${term}". Glossary: ${GLOSSARY}.`, citations: [] };
        for (const tb of tables) {
          citations.push({ id: `om:table:${tb.fullyQualifiedName}`, source: "openmetadata", kind: "dataset", title: tb.fullyQualifiedName, url: om.url("table", tb.fullyQualifiedName), ts: new Date(tb.updatedAt ?? Date.now()).toISOString() });
          out.push(`[[om:table:${tb.fullyQualifiedName}]] ${clip(tb.description ?? "", 200)} · owner ${(tb.owners ?? []).map((o: any) => o.displayName ?? o.name).join(", ") || "—"}`);
        }
      }
      return { text: out.filter(Boolean).join("\n"), citations };
    } catch (e) {
      return { text: `OpenMetadata is unavailable (${String(e).slice(0, 120)}); answer without catalog context and say so.`, citations: [] };
    }
  },
});

const getRecord = define({
  name: "get_record",
  description: "Open one cited record in full (ticket thread, call transcript, Slack thread, page, opportunity) by its id, e.g. zendesk:ticket:123.",
  shape: { id: z.string().describe("Record id exactly as cited, without brackets") },
  async run({ id }) {
    const clean = id.replace(/^\[+|\]+$/g, "");
    if (clean.startsWith("memory:")) {
      const m: any = await teamMemory.get(clean);
      if (!m) return { text: `No memory ${clean}.`, citations: [] };
      const c = memoryCitation({ ...m, _id: String(m._id) }, AGENT_NAMES);
      return { text: `[[${c.id}]] ${c.kind} · ${day(c.ts)} · tier ${m.tier} · importance ${Number(m.importance).toFixed(2)} · tags ${m.tags.join(", ")}\n\n${m.content}`, citations: [c], data: m };
    }
    const { docs } = await colls();
    const d = await docs.findOne({ _id: clean });
    if (!d) return { text: `No record ${id}.`, citations: [] };
    const c = cite(d, d.text);
    return { text: `[[${d._id}]] ${LABEL[d.source]} ${d.kind} · ${day(d.ts)} · ${d.title}\n${JSON.stringify(d.meta)}\n\n${clip(d.text, 6000)}`, citations: [c], data: d };
  },
});

const teamMemoryTool = define({
  name: "team_memory",
  description: "What Wisteria's agents (Support Lead, Account Manager, RevOps) have learned and saved to their shared memory: agent-memory on MongoDB Atlas. Use for 'what do our agents know about…', prior findings and decisions. Cite as [[memory:<id>]].",
  shape: { query: z.string().describe("What to recall, e.g. 'Novaris Holdings churn reason'"), limit: z.number().optional().describe("1–15 (default 8)") },
  async run({ query, limit }) {
    const hits = await teamMemory.recall(query, clamp(limit, 1, 15, 8)).catch(() => null);
    if (hits === null) return { text: "Team memory (agent-memory) is not reachable.", citations: [] };
    if (!hits.length) return { text: "The agents have not saved anything on this yet.", citations: [] };
    const citations = hits.map((m) => memoryCitation(m, AGENT_NAMES));
    return {
      text: `${hits.length} memories from the agents' shared memory (agent-memory · MongoDB Atlas):\n${hits.map((m) => `[[memory:${m._id}]] ${AGENT_NAMES[tagValue(m.tags, "agent") ?? ""] ?? "agent"} · ${day(m.created_at)} · ${m.content}`).join("\n")}`,
      citations,
      data: hits,
    };
  },
});

export const BRAIN_TOOLS = [searchBrain, account360, relatedEntities, whatChanged, explainData, getRecord, teamMemoryTool] as unknown as BrainTool[];

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  const t = BRAIN_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t.run(z.object(t.shape).parse(args));
}
