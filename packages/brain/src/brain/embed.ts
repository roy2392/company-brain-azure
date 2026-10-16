import { cfg } from "../config.ts";

export type EmbedKind = "document" | "query";

export interface Embedder {
  model: string;
  dims: number;
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

/** Local embeddings through Ollama. nomic-embed-text expects task prefixes. */
class OllamaEmbedder implements Embedder {
  constructor(readonly model: string, readonly dims: number) {}
  async embed(texts: string[], kind: EmbedKind) {
    const prefix = this.model.startsWith("nomic") ? (kind === "query" ? "search_query: " : "search_document: ") : "";
    const res = await fetch(`${cfg.embed.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts.map((t) => prefix + t), truncate: true }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return ((await res.json()) as { embeddings: number[][] }).embeddings;
  }
}

/** Voyage AI (MongoDB's embedding models). */
class VoyageEmbedder implements Embedder {
  readonly dims = 1024;
  constructor(readonly model: string, private key: string) {}
  async embed(texts: string[], kind: EmbedKind) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, input: texts, input_type: kind, output_dimension: this.dims }),
    });
    if (!res.ok) throw new Error(`voyage embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

let cached: Promise<Embedder | null> | undefined;

/** Returns null when no embedding provider is reachable — the brain then runs text-search only. */
export function getEmbedder(): Promise<Embedder | null> {
  cached ??= (async () => {
    const { provider } = cfg.embed;
    if (provider === "none") return null;
    if (provider === "voyage" && cfg.embed.voyageKey) return new VoyageEmbedder(cfg.embed.voyageModel, cfg.embed.voyageKey);
    try {
      const probe = new OllamaEmbedder(cfg.embed.ollamaModel, 0);
      const [v] = await probe.embed(["ping"], "query");
      return new OllamaEmbedder(cfg.embed.ollamaModel, v.length);
    } catch (e) {
      console.warn(`[embed] no embedding provider available (${e}); falling back to text search only`);
      return null;
    }
  })();
  return cached;
}

/** Embed in batches with bounded parallelism. */
export async function embedAll(embedder: Embedder, texts: string[], batch = 32, parallel = 2): Promise<number[][]> {
  const out: number[][] = new Array(texts.length);
  let next = 0;
  const worker = async () => {
    while (next < texts.length) {
      const start = next;
      next += batch;
      const vecs = await embedder.embed(texts.slice(start, start + batch), "document");
      vecs.forEach((v, i) => (out[start + i] = v));
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
}
