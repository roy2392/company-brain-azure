import { entity, personId } from "../../brain/entities.ts";
import { docId } from "../../brain/indexer.ts";
import type { BrainDoc, ConnectorOutput, Entity } from "../../brain/types.ts";
import type { EraClient } from "../client.ts";
import { adfToText, asDate, htmlToText, rawDoc, since, type PullContext } from "../util.ts";

const MAX_ISSUES = 1500;
const MAX_PAGES = 600;

/** Jira Cloud v3 (recent issues) + Confluence (pages), account mentions resolved from text. */
export async function pullAtlassian(era: EraClient, ctx: PullContext): Promise<ConnectorOutput> {
  const fields = "summary,description,status,priority,issuetype,project,labels,created,updated,assignee,reporter,components";
  const jql = `updated >= "${since(ctx).toISOString().slice(0, 10)}" ORDER BY updated DESC`;
  const issues: any[] = [];
  try {
    let token: string | undefined;
    do {
      const r = await era.rest<any>("/rest/api/3/search/jql", { query: { jql, fields, maxResults: 100, nextPageToken: token } });
      issues.push(...(r.issues ?? []));
      token = r.isLast ? undefined : r.nextPageToken;
    } while (token && issues.length < MAX_ISSUES);
  } catch {
    // older search endpoint
    for (let startAt = 0; issues.length < MAX_ISSUES; startAt += 100) {
      const r = await era.rest<any>("/rest/api/3/search", { query: { jql, fields, maxResults: 100, startAt } });
      issues.push(...(r.issues ?? []));
      if (!r.issues?.length || startAt + 100 >= (r.total ?? 0)) break;
    }
  }

  const pages: any[] = [];
  const spaces = new Map<string, string>();
  try {
    const sp = await era.rest<any>("/wiki/api/v2/spaces", { query: { limit: 250 } });
    for (const s of sp.results ?? []) spaces.set(String(s.id), s.name);
    let next: string | undefined = "/wiki/api/v2/pages?limit=100&body-format=storage";
    while (next && pages.length < MAX_PAGES) {
      const r: any = await era.rest<any>(next);
      pages.push(...(r.results ?? []));
      next = r._links?.next ? (r._links.next.startsWith("/wiki") ? r._links.next : `/wiki${r._links.next}`) : undefined;
    }
  } catch {
    for (let start = 0; pages.length < MAX_PAGES; start += 100) {
      const r = await era.rest<any>("/wiki/rest/api/content", { query: { type: "page", expand: "body.storage,space,version", limit: 100, start } });
      pages.push(...(r.results ?? []));
      if ((r.results?.length ?? 0) < 100) break;
    }
  }
  ctx.log(`   jira: ${issues.length} issues · confluence: ${pages.length} pages`);

  const docs: BrainDoc[] = [];
  const people = new Map<string, Entity>();
  const person = (u: any) => {
    if (!u?.displayName) return undefined;
    const id = personId(u.emailAddress ?? u.displayName);
    if (!people.has(id)) people.set(id, entity("person", id, u.displayName, "jira", { email: u.emailAddress, internal: true }));
    return id;
  };
  for (const i of issues) {
    const f = i.fields ?? {};
    const desc = typeof f.description === "string" ? f.description : adfToText(f.description);
    const text = `${f.summary ?? ""}\n${f.issuetype?.name ?? "Issue"} in ${f.project?.name ?? f.project?.key ?? ""}. Status: ${f.status?.name}. Priority: ${f.priority?.name ?? "n/a"}. Labels: ${(f.labels ?? []).join(", ")}. Assignee: ${f.assignee?.displayName ?? "unassigned"}.\n\n${desc}`;
    docs.push({
      _id: docId("jira", "issue", i.key ?? i.id),
      source: "jira",
      kind: "issue",
      sourceId: i.key ?? String(i.id),
      title: `${i.key} ${f.summary ?? ""}`,
      text,
      ts: asDate(f.updated ?? f.created, ctx.now),
      accountIds: ctx.matcher.match(`${f.summary ?? ""} ${(f.labels ?? []).join(" ")} ${desc}`),
      personIds: [person(f.assignee), person(f.reporter)].filter(Boolean) as string[],
      meta: { status: f.status?.name, priority: f.priority?.name, type: f.issuetype?.name, project: f.project?.key, labels: f.labels ?? [], escalated: /highest|critical|blocker/i.test(f.priority?.name ?? "") },
    });
  }
  for (const p of pages) {
    const html = p.body?.storage?.value ?? p.body?.value ?? "";
    const text = htmlToText(html);
    if (!text) continue;
    const space = spaces.get(String(p.spaceId)) ?? p.space?.name ?? "";
    docs.push({
      _id: docId("confluence", "page", p.id),
      source: "confluence",
      kind: "page",
      sourceId: String(p.id),
      title: p.title,
      text: `${p.title}${space ? ` (${space})` : ""}\n\n${text}`,
      ts: asDate(p.version?.createdAt ?? p.version?.when ?? p.createdAt, ctx.now),
      accountIds: ctx.matcher.match(`${p.title} ${text.slice(0, 20_000)}`),
      personIds: [],
      meta: { space },
    });
  }
  return {
    raw: [
      { collection: "raw_jira_issues", source: "jira", object: "issues", description: "Jira issues updated in the ingestion window.", docs: issues.map((i) => rawDoc(i.key ?? i.id, i)) },
      { collection: "raw_confluence_pages", source: "confluence", object: "pages", description: "Confluence pages (storage format) — runbooks, specs, customer notes.", docs: pages.map((p) => rawDoc(p.id, p)) },
    ],
    docs,
    entities: [...people.values()],
  };
}
