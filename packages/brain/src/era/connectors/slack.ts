import { entity, personId, slug } from "../../brain/entities.ts";
import { docId } from "../../brain/indexer.ts";
import type { BrainDoc, ConnectorOutput, Entity } from "../../brain/types.ts";
import type { EraClient } from "../client.ts";
import { mapLimit, rawDoc, since, slackTs, type PullContext } from "../util.ts";

/** Slack Web API: org chart (users.list), customer channels (#<account>, #<account>-bid …) and #general. */
export async function pullSlack(era: EraClient, ctx: PullContext, accountSlugs: Map<string, string>): Promise<ConnectorOutput> {
  const api = async (method: string, params: Record<string, unknown>) => {
    const r = await era.rest<any>(`/api/${method}`, { query: params });
    if (r.ok === false) throw new Error(`slack ${method}: ${r.error}`);
    return r;
  };
  const paged = async (method: string, key: string, params: Record<string, unknown>, max = 50_000) => {
    const out: any[] = [];
    let cursor: string | undefined;
    do {
      const r = await api(method, { ...params, cursor });
      out.push(...(r[key] ?? []));
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && out.length < max);
    return out;
  };

  const [users, channels] = await Promise.all([
    paged("users.list", "members", { limit: 1000 }),
    paged("conversations.list", "channels", { limit: 1000, types: "public_channel", exclude_archived: true }),
  ]);
  ctx.log(`   slack: ${users.length} members, ${channels.length} channels`);
  const userById = new Map(users.map((u) => [u.id, u]));
  const who = (id?: string) => (id ? userById.get(id)?.real_name ?? userById.get(id)?.name ?? id : "someone");
  const pid = (id?: string) => {
    const u = id ? userById.get(id) : undefined;
    return u ? personId(u.profile?.email ?? u.real_name ?? u.name) : undefined;
  };
  const clean = (t: string) => (t ?? "").replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${who(id)}`).replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1").replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2");

  // channel → account: longest dash-prefix of the channel name that is an account slug
  const channelAccount = (name: string) => {
    const parts = name.split("-");
    for (let n = parts.length; n >= 1; n--) {
      const id = accountSlugs.get(parts.slice(0, n).join("-"));
      if (id) return id;
    }
    return undefined;
  };
  const focusIds = new Set(ctx.focus.map((f) => f.id));
  const picked = channels
    .map((c) => ({ c, acct: channelAccount(c.name) }))
    .filter(({ c, acct }) => c.name === "general" || (acct && focusIds.has(acct)));
  ctx.log(`   slack: reading ${picked.length} channels (focus accounts + #general)`);

  const oldest = Math.floor(since(ctx).getTime() / 1000);
  const docs: BrainDoc[] = [];
  const rawMessages: any[] = [];
  const channelsByAcct = new Map<string, string[]>();

  await mapLimit(picked, 4, async ({ c, acct }) => {
    if (acct) channelsByAcct.set(acct, [...(channelsByAcct.get(acct) ?? []), c.name]);
    const history = await paged("conversations.history", "messages", { channel: c.id, limit: 200, oldest }, c.name === "general" ? 600 : 400);
    const threads = history.filter((m) => (m.reply_count ?? 0) > 0).sort((a, b) => b.reply_count - a.reply_count).slice(0, c.name === "general" ? 10 : 4);
    const replies = new Map<string, any[]>();
    await mapLimit(threads, 3, async (m) => {
      const r = await paged("conversations.replies", "messages", { channel: c.id, ts: m.ts, limit: 200 }, 200).catch(() => []);
      replies.set(m.ts, r.filter((x: any) => x.ts !== m.ts));
    });
    const accountIds = acct ? [acct] : [];
    for (const m of history) rawMessages.push(rawDoc(`${c.id}:${m.ts}`, { channel: c.name, channel_id: c.id, ...m }));
    // threads become their own docs; loose messages are grouped into one doc per channel-day
    const byDay = new Map<string, any[]>();
    for (const m of history) {
      if (m.subtype === "channel_join") continue;
      if (replies.has(m.ts)) {
        const rs = replies.get(m.ts)!;
        const participants = [...new Set([m.user, ...rs.map((r) => r.user)])].map(pid).filter(Boolean) as string[];
        docs.push({
          _id: docId("slack", "thread", `${c.id}:${m.ts}`),
          source: "slack",
          kind: "thread",
          sourceId: `${c.id}:${m.ts}`,
          title: `#${c.name}: ${clean(m.text).slice(0, 80)}`,
          text: [`${who(m.user)}: ${clean(m.text)}`, ...rs.map((r) => `${who(r.user)}: ${clean(r.text)}`)].join("\n"),
          ts: slackTs(rs.at(-1)?.ts ?? m.ts),
          accountIds: [...new Set([...accountIds, ...ctx.matcher.match(m.text ?? "")])],
          personIds: participants,
          meta: { channel: c.name, replies: rs.length },
        });
      } else {
        const day = slackTs(m.ts).toISOString().slice(0, 10);
        byDay.set(day, [...(byDay.get(day) ?? []), m]);
      }
    }
    for (const [day, msgs] of byDay) {
      msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
      const text = msgs.map((m) => `${who(m.user)}: ${clean(m.text)}`).join("\n");
      docs.push({
        _id: docId("slack", "channel-day", `${c.id}:${day}`),
        source: "slack",
        kind: "messages",
        sourceId: `${c.id}:${day}`,
        title: `#${c.name} on ${day}`,
        text,
        ts: slackTs(msgs.at(-1).ts),
        accountIds: [...new Set([...accountIds, ...ctx.matcher.match(text)])],
        personIds: [...new Set(msgs.map((m) => pid(m.user)).filter(Boolean) as string[])],
        meta: { channel: c.name, messages: msgs.length },
      });
    }
  });

  // mentions of focus accounts in every other channel (#sales, #support, #deal-desk…), via Slack search
  const pickedIds = new Set(picked.map(({ c }) => c.id));
  let mentions = 0;
  await mapLimit(ctx.focus, 4, async (f) => {
    const r = await api("search.messages", { query: `"${f.name}"`, count: 100, sort: "timestamp", sort_dir: "desc" }).catch(() => null);
    const matches = (r?.messages?.matches ?? []).filter((m: any) => Number(m.ts) >= oldest && !pickedIds.has(m.channel?.id));
    const byChannelDay = new Map<string, any[]>();
    for (const m of matches) {
      rawMessages.push(rawDoc(`${m.channel?.id}:${m.ts}`, { channel: m.channel?.name, channel_id: m.channel?.id, ...m }));
      const key = `${m.channel?.id}|${slackTs(m.ts).toISOString().slice(0, 10)}`;
      byChannelDay.set(key, [...(byChannelDay.get(key) ?? []), m]);
    }
    for (const [key, msgs] of byChannelDay) {
      const [channelId, day] = key.split("|");
      msgs.sort((a, b) => Number(a.ts) - Number(b.ts));
      const channel = msgs[0].channel?.name ?? channelId;
      mentions += msgs.length;
      docs.push({
        _id: docId("slack", "mentions", `${channelId}:${day}:${f.id}`),
        source: "slack",
        kind: "mentions",
        sourceId: `${channelId}:${day}`,
        title: `#${channel} on ${day}: ${f.name}`,
        text: msgs.map((m) => `${m.username ?? who(m.user)}: ${clean(m.text)}`).join("\n"),
        url: msgs[0].permalink,
        ts: slackTs(msgs.at(-1).ts),
        accountIds: [f.id],
        personIds: [...new Set(msgs.map((m) => pid(m.user)).filter(Boolean) as string[])],
        meta: { channel, messages: msgs.length },
      });
    }
  });
  ctx.log(`   slack: ${mentions} cross-channel mentions of focus accounts`);

  const entities: Entity[] = [];
  for (const u of users) {
    if (u.is_bot || u.deleted) continue;
    const p = u.profile ?? {};
    entities.push(entity("person", personId(p.email ?? u.real_name ?? u.name), u.real_name ?? u.name, "slack", { title: p.title || undefined, email: p.email, internal: true, slackId: u.id }));
  }
  for (const [acct, names] of channelsByAcct) {
    entities.push({ _id: acct, type: "account", name: acct.replace(/^account:/, ""), aliases: [], attrs: { slackChannels: names.sort() }, links: [], sources: ["slack"] });
  }
  ctx.log(`   slack: ${docs.length} docs from ${rawMessages.length} messages`);
  return {
    raw: [
      { collection: "raw_slack_users", source: "slack", object: "users", description: "Workspace members with titles — Wisteria's org chart.", docs: users.map((u) => rawDoc(u.id, u)) },
      { collection: "raw_slack_channels", source: "slack", object: "conversations", description: "Public channels, including one per customer account.", docs: channels.map((c) => rawDoc(c.id, c)) },
      { collection: "raw_slack_messages", source: "slack", object: "messages", description: "Messages and thread replies from customer channels and #general.", docs: rawMessages },
    ],
    docs,
    entities,
  };
}

export const slackSlug = slug;
