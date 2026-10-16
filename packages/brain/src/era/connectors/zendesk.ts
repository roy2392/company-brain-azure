import { accountId, entity, personId } from "../../brain/entities.ts";
import { docId } from "../../brain/indexer.ts";
import type { BrainDoc, ConnectorOutput, Entity } from "../../brain/types.ts";
import type { EraClient } from "../client.ts";
import { asDate, mapLimit, rawDoc, type PullContext } from "../util.ts";

/** Zendesk v2: organization per focus account → its tickets; full comment threads for escalations. */
export async function pullZendesk(era: EraClient, ctx: PullContext): Promise<ConnectorOutput> {
  const orgs: any[] = [];
  await mapLimit(ctx.focus, 4, async (f) => {
    const r = await era.rest<any>("/api/v2/search.json", { query: { query: `type:organization name:"${f.name}"` } }).catch(() => null);
    const org = (r?.results ?? []).find((o: any) => accountId(o.name) === f.id) ?? r?.results?.[0];
    if (org) orgs.push({ ...org, _account: f.id });
  });
  ctx.log(`   zendesk: matched ${orgs.length}/${ctx.focus.length} focus accounts to organizations`);

  const tickets: any[] = [];
  await mapLimit(orgs, 4, async (o) => {
    let url: string | null = `/api/v2/organizations/${o.id}/tickets.json?per_page=100`;
    let n = 0;
    while (url && n < 500) {
      const r: any = await era.rest<any>(url);
      for (const t of r.tickets ?? []) tickets.push({ ...t, _account: o._account, _org: o.name });
      n += r.tickets?.length ?? 0;
      url = r.next_page ?? null;
    }
  });

  const hot = (t: any) => /urgent|high/i.test(t.priority ?? "") || (t.tags ?? []).some((x: string) => /escalat/i.test(x));
  const byAcct = new Map<string, any[]>();
  for (const t of tickets.filter(hot)) byAcct.set(t._account, [...(byAcct.get(t._account) ?? []), t]);
  const withComments = [...byAcct.values()].flatMap((l) => l.sort((a, b) => +asDate(b.updated_at) - +asDate(a.updated_at)).slice(0, 4));
  const comments = new Map<number, any[]>();
  await mapLimit(withComments, 4, async (t) => {
    const r = await era.rest<any>(`/api/v2/tickets/${t.id}/comments.json`).catch(() => null);
    if (r?.comments) comments.set(t.id, r.comments);
  });

  // requesters/agents → people
  const userIds = [...new Set(tickets.flatMap((t) => [t.requester_id, t.assignee_id]).filter(Boolean))];
  const users = new Map<number, any>();
  for (let i = 0; i < userIds.length; i += 100) {
    const r = await era.rest<any>("/api/v2/users/show_many.json", { query: { ids: userIds.slice(i, i + 100).join(",") } }).catch(() => null);
    for (const u of r?.users ?? []) users.set(u.id, u);
  }
  ctx.log(`   zendesk: ${tickets.length} tickets, ${comments.size} comment threads, ${users.size} users`);

  const name = (id?: number) => (id ? users.get(id)?.name ?? `user ${id}` : "unknown");
  const docs: BrainDoc[] = tickets.map((t) => {
    const thread = comments.get(t.id);
    const body = thread?.length ? thread.map((c: any) => `${name(c.author_id)} (${String(c.created_at).slice(0, 10)}): ${c.plain_body ?? c.body ?? ""}`).join("\n\n") : (t.description ?? "");
    const req = users.get(t.requester_id);
    return {
      _id: docId("zendesk", "ticket", t.id),
      source: "zendesk",
      kind: "ticket",
      sourceId: String(t.id),
      title: `#${t.id} ${t.subject ?? "(no subject)"}`,
      text: `${t.subject ?? ""}\nOrganization: ${t._org}. Status: ${t.status}. Priority: ${t.priority ?? "normal"}. Type: ${t.type ?? "n/a"}. Requester: ${req?.name ?? "n/a"}. Tags: ${(t.tags ?? []).join(", ")}\n\n${body}`,
      ts: asDate(t.updated_at ?? t.created_at, ctx.now),
      accountIds: [t._account],
      personIds: [req?.email && personId(req.email)].filter(Boolean) as string[],
      meta: { status: t.status, priority: t.priority, escalated: hot(t), type: t.type, createdAt: t.created_at, tags: t.tags ?? [] },
    } satisfies BrainDoc;
  });
  const entities: Entity[] = [...users.values()]
    .filter((u) => u.email)
    .map((u) => {
      const org = orgs.find((o) => o.id === u.organization_id);
      return entity("person", personId(u.email), u.name, "zendesk", { email: u.email, internal: u.role !== "end-user", title: u.user_fields?.title }, org ? [{ to: org._account, rel: "contact_of", source: "zendesk" }] : []);
    });
  return {
    raw: [
      { collection: "raw_zendesk_organizations", source: "zendesk", object: "organizations", description: "Customer organizations in the help desk.", docs: orgs.map(({ _account, ...o }) => rawDoc(o.id, { ...o, account: _account })) },
      { collection: "raw_zendesk_tickets", source: "zendesk", object: "tickets", description: "Support tickets for focus accounts, with priority and status.", docs: tickets.map(({ _account, _org, ...t }) => rawDoc(t.id, { ...t, account: _account, comments: comments.get(t.id) ?? null })) },
      { collection: "raw_zendesk_users", source: "zendesk", object: "users", description: "Requesters and agents.", docs: [...users.values()].map((u) => rawDoc(u.id, u)) },
    ],
    docs,
    entities,
  };
}
