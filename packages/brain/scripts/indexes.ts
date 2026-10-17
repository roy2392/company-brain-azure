/**
 * (Re)create the Atlas Search and Vector Search indexes, e.g. after a mongorestore (dumps carry no search indexes).
 *   npm run indexes
 */
import { getEmbedder } from "../src/brain/embed.ts";
import { closeDb, ensureIndexes } from "../src/brain/store.ts";

const embedder = await getEmbedder();
await ensureIndexes(embedder?.dims ?? null);
console.log(`search indexes ensured (vector dims ${embedder?.dims ?? "none"})`);
await closeDb();
