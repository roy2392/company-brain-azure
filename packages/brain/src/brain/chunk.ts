import type { BrainDoc, Chunk } from "./types.ts";

const MAX = 1200;
const OVERLAP = 150;

/** Split on paragraph, then sentence, then hard boundaries; keep ~MAX chars with a small overlap. */
export function splitText(text: string, max = MAX, overlap = OVERLAP): string[] {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const pieces = clean.split(/\n\n+/).flatMap((p) => (p.length <= max ? [p] : p.split(/(?<=[.!?])\s+/)));
  const units = pieces.flatMap((p) => (p.length <= max ? [p] : p.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? []));
  const chunks: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > max) {
      chunks.push(cur);
      cur = cur.slice(Math.max(0, cur.length - overlap)) + "\n\n" + u;
      if (cur.length > max) cur = u;
    } else {
      cur = cur ? `${cur}\n\n${u}` : u;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function chunkDoc(doc: BrainDoc): Chunk[] {
  return splitText(doc.text).map((text, n) => ({
    _id: `${doc._id}#${n}`,
    docId: doc._id,
    source: doc.source,
    kind: doc.kind,
    title: doc.title,
    text,
    url: doc.url,
    ts: doc.ts,
    accountIds: doc.accountIds,
    personIds: doc.personIds,
  }));
}

/** Text that gets embedded: title gives every chunk its context. */
export const embedText = (c: Chunk) => `${c.title}\n${c.text}`;
