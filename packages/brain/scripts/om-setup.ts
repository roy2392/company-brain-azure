/**
 * Build the OpenMetadata side of the brain (idempotent):
 *   npm run om:setup                 # everything
 *   npm run om:setup -- --no-native  # skip the dockerized OpenMetadata MongoDB connector run
 *   npm run om:setup -- --rdf-reindex  # also re-project the whole catalog into RDF (after enabling RDF)
 * Works before ingestion (schemas from the vendor APIs) and refines columns from real records after it.
 */
import { closeDb, colls } from "../src/brain/store.ts";
import { importLeaders, registerAtlasCollections, registerEraSources, setupAiAssets, setupMetrics, setupOntology, wireLineage } from "../src/om/catalog.ts";
import { OM } from "../src/om/client.ts";
import { ingestAtlasNative } from "../src/om/ingest-atlas.ts";
import { setupAgentAssets } from "../src/om/agents.ts";
import { loadOntologyGraph, rdfStatus, refreshReasoners, reindexRdf, waitForProjection } from "../src/om/rdf.ts";

const native = !process.argv.includes("--no-native");
const om = await new OM().login();
const t0 = Date.now();
const { meta } = await colls();
const hasData = (await meta.countDocuments({ kind: "rawCollection" })) > 0;

console.log("① ontology: domains, teams, relation types, concepts, statements, data product");
await setupOntology(om);
if (hasData && native) {
  console.log("② OpenMetadata MongoDB connector → Atlas");
  await ingestAtlasNative(om);
}
console.log("③ Era source systems (tables, keys, ER diagram)");
await registerEraSources(om);
console.log("④ Atlas collections (descriptions, owners, concepts, PII)");
const schemaFqn = await registerAtlasCollections(om);
console.log("⑤ metrics and AI assets (LLMs, MCP servers, AI application)");
await setupMetrics(om, schemaFqn);
await setupAiAssets(om, schemaFqn);
console.log("⑥ lineage (table + column level)");
await wireLineage(om, schemaFqn);
console.log("⑦ owners from Era org chart");
await importLeaders(om);
console.log("⑧ Wisteria agents and their shared memory (agent-memory collections, MCP server, AI applications, lineage)");
await setupAgentAssets(om, schemaFqn).catch((e) => console.log(`  – agent assets skipped: ${String(e).slice(0, 200)}`));
const rdf = await rdfStatus(om).catch(() => ({ enabled: false }));
if (rdf.enabled) {
  console.log("⑨ RDF knowledge graph (Fuseki): Wisteria ontology graph for SPARQL + inference");
  if (process.argv.includes("--rdf-reindex")) await reindexRdf(om);
  else await waitForProjection(om, ["company_brain_agent", "wisteria_account_manager_agent", `${schemaFqn}.docs`, "era_salesforce.wisteria.salesforce.Contact"]);
  await loadOntologyGraph(om);
  await refreshReasoners();
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${om.ui}${hasData ? "" : "  (no Era data yet: schemas come from the vendor APIs; re-run after npm run ingest)"}`);
await closeDb();
