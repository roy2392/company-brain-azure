import { z } from "zod";
import { OM } from "../om/client.ts";
import { GLOSSARY } from "../om/ontology.ts";
import { findEntities, searchChunks } from "./search.ts";
import { brainNow, colls } from "./store.ts";
import { SOURCES, type BrainDoc, type Citation, type Entity, type Source } from "./types.ts";

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
};

const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
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
    sources: z.array(z.enum(SOURCES)).optional().describe("Restrict to these systems"),
    since_days: z.number().int().positive().optional().describe("Only content from the last N days"),
    limit: z.number().int().min(1).max(20).optional(),
  },
  async run({ query, account, sources, since_days, limit }) {
    const acct = account ? await resolveAccount(account) : null;
    if (account && !acct) return notFound(account);
    const since = since_days ? new Date((await brainNow()).getTime() - since_days * DAY) : undefined;
    const { hits, mode } = await searchChunks({ query, accountIds: acct ? [acct._id] : undefined, sources: sources as Source[] | undefined, since, limit: limit ?? 8 });
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
    const tickets = all.filter((d) => d.kind === "ticket" || d.kind === "case");
    const openTickets = tickets.filter((t) => !/closed|solved|resolved/i.test(String(t.meta.status ?? "")));
    const escalations = tickets.filter((t) => t.meta.escalated || /urgent|high|critical/i.test(String(t.meta.priority ?? "")));
    const calls = by("gong", "call").slice(0, 5);
    const issues = all.filter((d) => d.source === "jira").slice(0, 5);
    const people = await entities.find({ "links.to": acct._id, type: "person" }, { projection: { name: 1, attrs: 1, links: 1 } }).limit(25).toArray();

    const highlight = [...open.slice(0, 5), ...escalations.slice(0, 5), ...calls, ...issues, ...all.slice(0, 8)];
    const citations = [...new Map(highlight.map((d) => [d._id, cite(d)])).values()];
    const fmt$ = (n: number) => (n ? `$${Math.round(n).toLocaleString("en-US")}` : "—");
    const a = acct.attrs as Record<string, any>;
    const data = {
      account: { id: acct._id, name: acct.name, ...a, sources: acct.sources },
      commercial: { openPipeline: sum(open), openOpportunities: open.length, closedWon: sum(won), arr: a.arr ?? null },
      support: { open: openTickets.length, escalations: escalations.length, last90: tickets.filter((t) => t.ts >= since90).length },
      activity: counts,
      people: people.map((p) => ({ id: p._id, name: p.name, title: p.attrs?.title, rel: p.links?.find((l: any) => l.to === acct._id)?.rel })),
      lastActivity: all[0]?.ts ?? null,
    };
    const text = [
      `${acct.name} (${acct._id}) — ${[a.type, a.industry, a.region].filter(Boolean).join(" · ") || "account"}${a.owner ? ` · owner ${a.owner}` : ""}`,
      `Commercial: ARR ${fmt$(a.arr)} · open pipeline ${fmt$(data.commercial.openPipeline)} across ${open.length} opps · closed-won ${fmt$(data.commercial.closedWon)}`,
      `Support: ${openTickets.length} open tickets, ${escalations.length} escalations, ${data.support.last90} tickets in last 90d`,
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
    depth: z.number().int().min(1).max(3).optional(),
  },
  async run({ entity, depth }) {
    const { entities } = await colls();
    const start = entity.includes(":") ? await entities.findOne({ _id: entity }) : await resolveAccount(entity);
    if (!start) return { text: `No entity "${entity}".`, citations: [] };
    const [g] = await entities
      .aggregate([
        { $match: { _id: start._id } },
        { $graphLookup: { from: "entities", startWith: "$links.to", connectFromField: "links.to", connectToField: "_id", as: "out", maxDepth: (depth ?? 1) - 1, depthField: "hop" } },
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
    days: z.number().int().min(7).max(365).optional(),
  },
  async run({ account, days }) {
    const n = days ?? 91;
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
    const { docs } = await colls();
    const d = await docs.findOne({ _id: id.replace(/^\[+|\]+$/g, "") });
    if (!d) return { text: `No record ${id}.`, citations: [] };
    const c = cite(d, d.text);
    return { text: `[[${d._id}]] ${LABEL[d.source]} ${d.kind} · ${day(d.ts)} · ${d.title}\n${JSON.stringify(d.meta)}\n\n${clip(d.text, 6000)}`, citations: [c], data: d };
  },
});

export const BRAIN_TOOLS = [searchBrain, account360, relatedEntities, whatChanged, explainData, getRecord] as unknown as BrainTool[];

export async function runTool(name: string, args: unknown): Promise<ToolResult> {
  const t = BRAIN_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`unknown tool ${name}`);
  return t.run(z.object(t.shape).parse(args));
}
