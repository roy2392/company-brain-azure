/**
 * End-to-end check of the brain without the LLM: Atlas contents, indexes, every tool, OpenMetadata.
 *   npm run smoke
 */
import { runTool } from "../src/brain/tools.ts";
import { brainNow, closeDb, colls, SEARCH_INDEX, VECTOR_INDEX } from "../src/brain/store.ts";
import { OM } from "../src/om/client.ts";

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const { docs, chunks, entities, meta } = await colls();
const bySource = await docs.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$source", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
check(bySource.length > 0, "Atlas holds docs", bySource.map((s) => `${s._id} ${s.n}`).join(", ") || "empty — run npm run ingest");
const nChunks = await chunks.estimatedDocumentCount();
const nEmbedded = await chunks.countDocuments({ embedding: { $exists: true } });
check(nChunks > 0, "chunks indexed", `${nChunks} chunks, ${nEmbedded} with embeddings`);
const idx = (await chunks.listSearchIndexes().toArray()) as any[];
check(idx.some((i) => i.name === SEARCH_INDEX && i.queryable), "Atlas Search index queryable");
check(!nEmbedded || idx.some((i) => i.name === VECTOR_INDEX && i.queryable), "Vector Search index queryable");
check((await entities.countDocuments({ type: "account" })) > 0, "entity graph has accounts", `${await entities.countDocuments()} entities`);
console.log(`  brain "today": ${(await brainNow()).toISOString().slice(0, 10)}`);

const focus = ((await meta.findOne({ _id: "focus" }))?.accounts ?? []) as Array<{ name: string }>;
const account = focus[0]?.name;
if (account) {
  const a = await runTool("account_360", { account });
  check(a.citations.length > 0, `account_360 "${account}"`, `${a.citations.length} citations`);
  const s = await runTool("search_brain", { query: "renewal risk escalation unhappy", account, limit: 5 });
  check(s.citations.length > 0, "search_brain (hybrid, scoped)", `${(s.data as any)?.mode}, ${s.citations.length} hits`);
  const r = await runTool("related_entities", { entity: account });
  check(((r.data as any)?.nodes?.length ?? 0) > 0, "related_entities ($graphLookup)", `${(r.data as any)?.nodes?.length ?? 0} connections`);
}
const w = await runTool("what_changed", {});
check(w.text.length > 0, "what_changed", w.text.split("\n")[0]);

try {
  const om = new OM();
  const v = await om.get("/system/version");
  check(true, "OpenMetadata reachable", v.version);
  const e = await runTool("explain_data", { term: "ARR" });
  check(e.citations.some((c) => c.id.includes("glossaryTerm")), "explain_data ARR → governed glossary term", e.text.split("\n")[0].slice(0, 120));
  const tables = await om.search("*", "table_search_index", 0);
  check((tables.hits?.total?.value ?? 0) > 0, "OpenMetadata has datasets", `${tables.hits?.total?.value ?? 0} tables`);
} catch (err) {
  check(false, "OpenMetadata", String(err));
}

await closeDb();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
