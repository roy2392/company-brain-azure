import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { cfg } from "../config.ts";
import type { BrainDoc, Chunk, Entity } from "./types.ts";

let client: MongoClient | undefined;
let db: Db | undefined;

export async function getDb(): Promise<Db> {
  if (db) return db;
  client = new MongoClient(cfg.mongo.uri, { appName: "wisteria-company-brain" });
  await client.connect();
  db = client.db(cfg.mongo.db);
  return db;
}

export async function closeDb() {
  await client?.close();
  client = undefined;
  db = undefined;
}

export const colls = async () => {
  const d = await getDb();
  return {
    docs: d.collection<BrainDoc>("docs"),
    chunks: d.collection<Chunk>("chunks"),
    entities: d.collection<Entity>("entities"),
    meta: d.collection<{ _id: string } & Document>("meta"),
    raw: (name: string) => d.collection<Document & { _id: string }>(name),
  };
};

export const SEARCH_INDEX = "chunks_text";
export const VECTOR_INDEX = "chunks_vector";
export const ENTITY_INDEX = "entities_name";

/** Regular + Atlas Search + Vector Search indexes. Idempotent; waits until search indexes are queryable. */
export async function ensureIndexes(dims: number | null) {
  const { docs, chunks, entities } = await colls();
  await Promise.all([
    docs.createIndex({ accountIds: 1, ts: -1 }),
    docs.createIndex({ source: 1, kind: 1, ts: -1 }),
    docs.createIndex({ personIds: 1 }),
    chunks.createIndex({ docId: 1 }),
    entities.createIndex({ type: 1, name: 1 }),
    entities.createIndex({ "links.to": 1 }),
  ]);

  const wanted: Array<{ coll: Collection<any>; name: string; type: "search" | "vectorSearch"; definition: Document }> = [
    {
      coll: chunks,
      name: SEARCH_INDEX,
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            text: { type: "string", analyzer: "lucene.english" },
            title: { type: "string", analyzer: "lucene.english" },
            source: { type: "token" },
            kind: { type: "token" },
            accountIds: { type: "token" },
            ts: { type: "date" },
          },
        },
      },
    },
    {
      coll: entities,
      name: ENTITY_INDEX,
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            name: [{ type: "string" }, { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15 }],
            aliases: { type: "string" },
            type: { type: "token" },
          },
        },
      },
    },
  ];
  if (dims) {
    wanted.push({
      coll: chunks,
      name: VECTOR_INDEX,
      type: "vectorSearch",
      definition: {
        fields: [
          { type: "vector", path: "embedding", numDimensions: dims, similarity: "cosine" },
          { type: "filter", path: "source" },
          { type: "filter", path: "kind" },
          { type: "filter", path: "accountIds" },
          { type: "filter", path: "ts" },
        ],
      },
    });
  }

  for (const w of wanted) {
    const existing: any[] = await w.coll.listSearchIndexes(w.name).toArray();
    const current = existing[0];
    const dimsChanged =
      w.type === "vectorSearch" &&
      current?.latestDefinition?.fields?.[0]?.numDimensions !== undefined &&
      current.latestDefinition.fields[0].numDimensions !== dims;
    if (current && dimsChanged) {
      await w.coll.dropSearchIndex(w.name);
      await waitFor(async () => (await w.coll.listSearchIndexes(w.name).toArray()).length === 0, `drop ${w.name}`);
    }
    if (!current || dimsChanged) {
      await w.coll.createSearchIndex({ name: w.name, type: w.type, definition: w.definition });
    }
  }
  for (const w of wanted) {
    await waitFor(async () => {
      const [ix]: any[] = await w.coll.listSearchIndexes(w.name).toArray();
      return ix?.queryable === true;
    }, `index ${w.name}`);
  }
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 180_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** The brain's notion of "now" — latest event in the data (Era environments can be moved in time). */
export async function brainNow(): Promise<Date> {
  const { meta, docs } = await colls();
  const m = await meta.findOne({ _id: "clock" });
  if (m?.now) return new Date(m.now);
  const latest = await docs.find({}, { projection: { ts: 1 } }).sort({ ts: -1 }).limit(1).next();
  return latest?.ts ?? new Date();
}
