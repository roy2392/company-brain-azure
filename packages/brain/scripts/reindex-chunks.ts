/**
 * Rebuild the search chunks (and their embeddings) from the docs already in Atlas, without pulling Era again.
 * For a store restored from a dump without chunks, or after changing the embedding model.
 *   npm run reindex             # chunk + embed docs whose chunks are missing or changed
 *   npm run reindex -- --all    # re-embed every chunk
 */
import { chunkDoc, embedText } from "../src/brain/chunk.ts";
import { embedAll, getEmbedder } from "../src/brain/embed.ts";
import { closeDb, colls, ensureIndexes } from "../src/brain/store.ts";
import type { BrainDoc, Chunk } from "../src/brain/types.ts";

const ALL = process.argv.includes("--all");
const BATCH = 400; // docs per round
const t0 = Date.now();
const { docs, chunks } = await colls();
const embedder = await getEmbedder();
console.log(`▸ embeddings: ${embedder ? `${embedder.model} (${embedder.dims}d)` : "off (text search only)"}`);
await ensureIndexes(embedder?.dims ?? null);

const total = await docs.estimatedDocumentCount();
let seen = 0, written = 0, embedded = 0;
const cursor = docs.find({}).batchSize(BATCH);
let page: BrainDoc[] = [];
const flush = async () => {
  const all: Chunk[] = page.flatMap(chunkDoc);
  const prior = ALL
    ? new Map()
    : new Map((await chunks.find({ _id: { $in: all.map((c) => c._id) } }, { projection: { text: 1, embedding: 1 } }).toArray()).map((c) => [c._id, c]));
  const todo = all.filter((c) => {
    const p = prior.get(c._id);
    if (p?.embedding && p.text === c.text) {
      c.embedding = p.embedding;
      return false;
    }
    return true;
  });
  if (embedder && todo.length) {
    const vecs = await embedAll(embedder, todo.map(embedText), 32, 4);
    todo.forEach((c, i) => (c.embedding = vecs[i]));
    embedded += todo.length;
  }
  if (all.length) await chunks.bulkWrite(all.map((c) => ({ replaceOne: { filter: { _id: c._id }, replacement: c, upsert: true } })), { ordered: false });
  written += all.length;
  seen += page.length;
  page = [];
  const s = (Date.now() - t0) / 1000;
  console.log(`   ${seen}/${total} docs → ${written} chunks (${embedded} embedded) · ${s.toFixed(0)}s`);
};
for await (const d of cursor) {
  page.push(d as BrainDoc);
  if (page.length >= BATCH) await flush();
}
if (page.length) await flush();

// drop chunks whose doc no longer exists
const docIds = new Set((await docs.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
const orphans = (await chunks.find({}, { projection: { docId: 1 } }).toArray()).filter((c) => !docIds.has(c.docId)).map((c) => c._id);
if (orphans.length) await chunks.deleteMany({ _id: { $in: orphans } });
console.log(`✓ ${written} chunks for ${seen} docs, ${embedded} embedded, ${orphans.length} orphans removed, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
await closeDb();
