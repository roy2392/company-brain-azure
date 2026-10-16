import type { AnyBulkWriteOperation } from "mongodb";
import { chunkDoc, embedText } from "./chunk.ts";
import { embedAll, getEmbedder } from "./embed.ts";
import { mergeEntities } from "./entities.ts";
import { colls } from "./store.ts";
import type { BrainDoc, Chunk, ConnectorOutput, Entity } from "./types.ts";

const BULK = 500;

async function bulkUpsert<T extends { _id: string }>(coll: { bulkWrite: (ops: any[], o?: any) => Promise<unknown> }, docs: T[]) {
  for (let i = 0; i < docs.length; i += BULK) {
    const ops: AnyBulkWriteOperation<T>[] = docs
      .slice(i, i + BULK)
      .map((d) => ({ replaceOne: { filter: { _id: d._id } as any, replacement: d, upsert: true } }));
    await coll.bulkWrite(ops, { ordered: false });
  }
}

/** Entities from several connectors are merged with what is already stored (links/aliases/sources union). */
async function upsertEntities(list: Entity[]) {
  const { entities } = await colls();
  const merged = mergeEntities(list);
  const existing = await entities.find({ _id: { $in: merged.map((e) => e._id) } }).toArray();
  await bulkUpsert(entities, mergeEntities([...existing, ...merged]));
}

/** Persist one connector's output: raw collections, docs, chunks (+ embeddings), entities. */
export async function indexOutput(out: ConnectorOutput, log = console.log) {
  const { docs, chunks, meta, raw } = await colls();
  for (const r of out.raw) {
    await bulkUpsert(raw(r.collection), r.docs);
    // remembered for the OpenMetadata catalog (service/table/lineage registration)
    await meta.updateOne(
      { _id: `raw:${r.collection}` },
      { $set: { kind: "rawCollection", collection: r.collection, source: r.source, object: r.object, description: r.description } },
      { upsert: true },
    );
  }
  await bulkUpsert(docs, out.docs);
  await upsertEntities(out.entities);

  const all: Chunk[] = out.docs.flatMap(chunkDoc);
  // skip chunks that already have an embedding and unchanged text
  const prior = new Map(
    (await chunks.find({ _id: { $in: all.map((c) => c._id) } }, { projection: { text: 1, embedding: 1 } }).toArray()).map((c) => [c._id, c]),
  );
  const embedder = await getEmbedder();
  const todo = all.filter((c) => {
    const p = prior.get(c._id);
    if (p?.embedding && p.text === c.text) {
      c.embedding = p.embedding;
      return false;
    }
    return true;
  });
  if (embedder && todo.length) {
    const t0 = Date.now();
    const vecs = await embedAll(embedder, todo.map(embedText));
    todo.forEach((c, i) => (c.embedding = vecs[i]));
    log(`   embedded ${todo.length} chunks in ${((Date.now() - t0) / 1000).toFixed(1)}s (${embedder.model})`);
  }
  await bulkUpsert(chunks, all);
  // drop chunks of re-indexed docs that shrank
  const ids = new Set(all.map((c) => c._id));
  const stale = await chunks.find({ docId: { $in: out.docs.map((d) => d._id) } }, { projection: { _id: 1 } }).toArray();
  const staleIds = stale.map((s) => s._id).filter((id) => !ids.has(id));
  if (staleIds.length) await chunks.deleteMany({ _id: { $in: staleIds } });
  return { docs: out.docs.length, chunks: all.length, entities: out.entities.length };
}

export function docId(source: BrainDoc["source"], kind: string, sourceId: string | number) {
  return `${source}:${kind}:${sourceId}`;
}
