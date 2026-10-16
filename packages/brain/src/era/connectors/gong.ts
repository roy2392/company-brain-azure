import { entity, personId } from "../../brain/entities.ts";
import { docId } from "../../brain/indexer.ts";
import type { BrainDoc, ConnectorOutput, Entity } from "../../brain/types.ts";
import type { EraClient } from "../client.ts";
import { asDate, rawDoc, since, type PullContext } from "../util.ts";

/** Gong v2: calls in the window, matched to accounts by CRM context or title; transcripts for focus accounts. */
export async function pullGong(era: EraClient, ctx: PullContext): Promise<ConnectorOutput> {
  const from = since(ctx).toISOString();
  const to = new Date(ctx.now.getTime() + 86_400_000).toISOString();
  const calls: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await era.rest<any>("/v2/calls", { query: { fromDateTime: from, toDateTime: to, cursor } });
    calls.push(...(r.calls ?? []));
    cursor = r.records?.cursor;
  } while (cursor && calls.length < 20_000);
  ctx.log(`   gong: ${calls.length} calls since ${from.slice(0, 10)}`);

  const focusBySf = new Map(ctx.focus.filter((f) => f.sfId).map((f) => [f.sfId!, f.id]));
  const focusIds = new Set(ctx.focus.map((f) => f.id));

  // extensive metadata (parties + CRM context + AI content) in batches of 100
  const ext = new Map<string, any>();
  for (let i = 0; i < calls.length; i += 100) {
    const ids = calls.slice(i, i + 100).map((c) => String(c.id));
    try {
      const r = await era.rest<any>("/v2/calls/extensive", {
        method: "POST",
        body: {
          filter: { callIds: ids },
          contentSelector: { context: "Extended", exposedFields: { parties: true, content: { brief: true, keyPoints: true, highlights: true, outline: true, topics: true } } },
        },
      });
      for (const c of r.calls ?? []) ext.set(String(c.metaData?.id ?? c.id), c);
    } catch (e) {
      ctx.log(`   gong: extensive unavailable (${String(e).slice(0, 80)}) — using call list only`);
      break;
    }
  }

  const accountsOf = (c: any, e: any): string[] => {
    const ids = new Set<string>();
    for (const ctxObj of e?.context ?? [])
      for (const o of ctxObj.objects ?? [])
        if (/account/i.test(o.objectType) && focusBySf.has(o.objectId)) ids.add(focusBySf.get(o.objectId)!);
    for (const id of ctx.matcher.match(`${c.title ?? e?.metaData?.title ?? ""}`)) ids.add(id);
    return [...ids];
  };

  const matched = calls.map((c) => ({ c, e: ext.get(String(c.id)), acct: accountsOf(c, ext.get(String(c.id))) }));
  const forTranscript = matched.filter((m) => m.acct.some((a) => focusIds.has(a))).map((m) => String(m.c.id));
  const transcripts = new Map<string, any[]>();
  for (let i = 0; i < forTranscript.length; i += 100) {
    try {
      const r = await era.rest<any>("/v2/calls/transcript", { method: "POST", body: { filter: { callIds: forTranscript.slice(i, i + 100) } } });
      for (const t of r.callTranscripts ?? []) transcripts.set(String(t.callId), t.transcript ?? []);
    } catch (e) {
      ctx.log(`   gong: transcripts unavailable (${String(e).slice(0, 80)})`);
      break;
    }
  }
  ctx.log(`   gong: ${forTranscript.length} focus-account calls, ${transcripts.size} transcripts`);

  const docs: BrainDoc[] = [];
  const entities: Entity[] = [];
  for (const { c, e, acct } of matched) {
    if (!acct.length && !transcripts.has(String(c.id))) continue;
    const parties: any[] = e?.parties ?? [];
    const speaker = new Map(parties.map((p) => [String(p.speakerId ?? p.id), p.name ?? p.emailAddress ?? "Speaker"]));
    const content = e?.content ?? {};
    const tr = transcripts.get(String(c.id)) ?? [];
    const transcriptText = tr.map((seg: any) => `${speaker.get(String(seg.speakerId)) ?? "Speaker"}: ${(seg.sentences ?? []).map((s: any) => s.text).join(" ")}`).join("\n");
    const summary = [
      content.brief && `Brief: ${content.brief}`,
      content.keyPoints?.length && `Key points:\n${content.keyPoints.map((k: any) => `• ${k.text ?? k}`).join("\n")}`,
      content.highlights?.length && `Highlights:\n${content.highlights.flatMap((h: any) => (h.items ?? [h]).map((x: any) => `• ${x.text ?? x.title ?? ""}`)).join("\n")}`,
      content.topics?.length && `Topics: ${content.topics.map((t: any) => t.name ?? t).join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const people = parties.filter((p) => p.emailAddress).map((p) => personId(p.emailAddress));
    for (const p of parties) {
      if (!p.emailAddress) continue;
      const external = p.affiliation === "External";
      entities.push(entity("person", personId(p.emailAddress), p.name ?? p.emailAddress, "gong", { title: p.title || undefined, email: p.emailAddress, internal: !external }, external ? acct.map((a) => ({ to: a, rel: "contact_of", source: "gong" as const })) : []));
    }
    const started = asDate(c.started ?? e?.metaData?.started, ctx.now);
    docs.push({
      _id: docId("gong", "call", c.id),
      source: "gong",
      kind: "call",
      sourceId: String(c.id),
      title: c.title ?? e?.metaData?.title ?? `Call ${c.id}`,
      text: [`${c.title ?? ""} — ${started.toISOString().slice(0, 10)}, ${Math.round((c.duration ?? 0) / 60)} min. Participants: ${parties.map((p) => p.name).filter(Boolean).join(", ") || "n/a"}.`, summary, transcriptText && `Transcript:\n${transcriptText}`].filter(Boolean).join("\n\n"),
      url: c.url,
      ts: started,
      accountIds: acct,
      personIds: people,
      meta: { durationMin: Math.round((c.duration ?? 0) / 60), participants: parties.length, direction: c.direction, hasTranscript: tr.length > 0 },
    });
  }
  return {
    raw: [
      { collection: "raw_gong_calls", source: "gong", object: "calls", description: "Recorded customer calls with participants and CRM context.", docs: calls.map((c) => rawDoc(c.id, { ...c, extensive: ext.get(String(c.id)) ?? null })) },
      ...(transcripts.size
        ? [{ collection: "raw_gong_transcripts", source: "gong" as const, object: "transcripts", description: "Speaker-attributed call transcripts for focus accounts.", docs: [...transcripts].map(([id, t]) => rawDoc(id, { callId: id, transcript: t })) }]
        : []),
    ],
    docs,
    entities,
  };
}
