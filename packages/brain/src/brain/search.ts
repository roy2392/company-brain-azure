import type { Document } from "mongodb";
import { getEmbedder } from "./embed.ts";
import { colls, SEARCH_INDEX, VECTOR_INDEX } from "./store.ts";
import type { Chunk, Source } from "./types.ts";

export interface SearchOpts {
  query: string;
  accountIds?: string[];
  sources?: Source[];
  since?: Date;
  limit?: number;
}

export type Hit = Omit<Chunk, "embedding"> & { score: number };

const PROJECT = { embedding: 0 };

/** Reciprocal-rank fusion — used when $rankFusion isn't available on the cluster tier. */
export function rrf<T extends { _id: string }>(lists: T[][], k = 60): Array<T & { score: number }> {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const cur = scores.get(item._id) ?? { item, score: 0 };
      cur.score += 1 / (k + rank + 1);
      scores.set(item._id, cur);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).map(({ item, score }) => ({ ...item, score }));
}

function textStage(o: SearchOpts): Document {
  const filter: Document[] = [];
  if (o.accountIds?.length) filter.push({ in: { path: "accountIds", value: o.accountIds } });
  if (o.sources?.length) filter.push({ in: { path: "source", value: o.sources } });
  if (o.since) filter.push({ range: { path: "ts", gte: o.since } });
  return {
    $search: {
      index: SEARCH_INDEX,
      compound: {
        should: [
          { text: { query: o.query, path: "title", score: { boost: { value: 2 } } } },
          { text: { query: o.query, path: "text" } },
        ],
        minimumShouldMatch: 1,
        filter,
      },
    },
  };
}

function vectorStage(o: SearchOpts, queryVector: number[], limit: number): Document {
  const filter: Document = {};
  if (o.accountIds?.length) filter.accountIds = { $in: o.accountIds };
  if (o.sources?.length) filter.source = { $in: o.sources };
  if (o.since) filter.ts = { $gte: o.since };
  return {
    $vectorSearch: {
      index: VECTOR_INDEX,
      path: "embedding",
      queryVector,
      numCandidates: limit * 15,
      limit: limit * 3,
      ...(Object.keys(filter).length ? { filter } : {}),
    },
  };
}

/** Hybrid retrieval: native $rankFusion (vector + full-text), app-side RRF fallback, text-only without embeddings. */
export async function searchChunks(o: SearchOpts): Promise<{ hits: Hit[]; mode: string }> {
  const { chunks } = await colls();
  const limit = o.limit ?? 8;
  const embedder = await getEmbedder();
  const text = [textStage(o), { $limit: limit * 3 }];
  if (!embedder) {
    const hits = await chunks.aggregate<Hit>([...text, { $limit: limit }, { $project: PROJECT }, { $set: { score: { $meta: "searchScore" } } }]).toArray();
    return { hits, mode: "text" };
  }
  const [qv] = await embedder.embed([o.query], "query");
  const vector = [vectorStage(o, qv, limit)];
  try {
    const hits = await chunks
      .aggregate<Hit>([
        { $rankFusion: { input: { pipelines: { vector, text } }, combination: { weights: { vector: 1, text: 1 } } } },
        { $limit: limit },
        { $project: PROJECT },
        { $set: { score: { $meta: "score" } } },
      ])
      .toArray();
    return { hits, mode: "rankFusion" };
  } catch {
    const [v, t] = await Promise.all([
      chunks.aggregate<Hit>([...vector, { $project: PROJECT }]).toArray(),
      chunks.aggregate<Hit>([...text, { $project: PROJECT }]).toArray(),
    ]);
    return { hits: rrf([v, t]).slice(0, limit), mode: "rrf" };
  }
}

/** Fuzzy entity lookup by name ("acacia", "Acacia Partners Ltd") via the Atlas Search autocomplete index. */
export async function findEntities(name: string, type?: string, limit = 5) {
  const { entities } = await colls();
  const filter = type ? [{ equals: { path: "type", value: type } }] : [];
  return entities
    .aggregate([
      {
        $search: {
          index: "entities_name",
          compound: {
            should: [
              { text: { query: name, path: "name", score: { boost: { value: 3 } } } },
              { autocomplete: { query: name, path: "name", fuzzy: { maxEdits: 1 } } },
              { text: { query: name, path: "aliases" } },
            ],
            minimumShouldMatch: 1,
            filter,
          },
        },
      },
      { $limit: limit },
      { $project: { links: 0 } },
    ])
    .toArray();
}
