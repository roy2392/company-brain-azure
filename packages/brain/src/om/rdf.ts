import { spawnSync } from "node:child_process";
import type { OM } from "./client.ts";

/** OpenMetadata's RDF knowledge graph (Fuseki): status, full re-projection, SPARQL. */

export type Inference = "none" | "rdfs" | "owl" | "custom";

export interface SparqlResult {
  vars: string[];
  rows: Array<Record<string, string>>;
}

export async function rdfStatus(om: OM): Promise<{ enabled: boolean; inference?: { enabled: boolean; defaultLevel: string }; storageType?: string; projectionState?: string }> {
  return om.get("/rdf/status");
}

const FUSEKI = process.env.FUSEKI_URL ?? "http://localhost:3030";

/**
 * inference "none" goes through OpenMetadata's API. "rdfs" / "owl" go to the Jena reasoner services we add to
 * Fuseki (openmetadata_rdfs / openmetadata_owl) — OpenMetadata 2.0.5's own inference path fails against Fuseki.
 */
export async function sparql(om: OM, query: string, inference: Inference = "none"): Promise<SparqlResult> {
  let json: any;
  if (inference === "none") {
    const res = await om.req<any>("POST", "/rdf/sparql", { query, format: "json", inference });
    json = typeof res === "string" ? JSON.parse(res) : res;
  } else {
    const service = inference === "rdfs" ? "openmetadata_rdfs" : "openmetadata_owl";
    const res = await fetch(`${FUSEKI}/${service}/sparql`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/sparql-results+json" },
      body: new URLSearchParams({ query }),
    });
    if (!res.ok) throw new Error(`Fuseki ${service} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    json = await res.json();
  }
  const vars: string[] = json.head?.vars ?? [];
  const rows = (json.results?.bindings ?? []).map((b: any) => Object.fromEntries(vars.map((v) => [v, b[v]?.value ?? ""])));
  return { vars, rows };
}

/** Re-project the whole catalog into RDF with the built-in RdfIndexApp and wait for it to finish. */
export async function reindexRdf(om: OM, log = console.log, timeoutMs = 600_000) {
  const installed = await om.byName("apps", "RdfIndexApp");
  if (!installed) {
    const def = await om.get<any>("/apps/marketplace/name/RdfIndexApp");
    await om.req("POST", "/apps", { name: "RdfIndexApp", appConfiguration: def.appConfiguration ?? { entities: [], recreateIndex: true, batchSize: 100 }, appSchedule: { scheduleTimeline: "None" } });
    log("  ✓ installed RdfIndexApp");
  }
  const started = Date.now();
  await om.req("POST", "/apps/trigger/RdfIndexApp", { recreateIndex: true, entities: ["all"] }).catch(async () => om.req("POST", "/apps/trigger/RdfIndexApp", {}));
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const st = await om.get<any>("/apps/name/RdfIndexApp/status?limit=1");
    const run = st.data?.[0];
    if (run && run.startTime >= started - 5000 && ["success", "completed", "failed", "activeError", "stopped"].includes(run.status)) {
      const stats = run.successContext?.stats?.jobStats ?? run.successContext?.stats ?? {};
      log(`  ${run.status === "success" || run.status === "completed" ? "✓" : "✗"} RDF re-projection ${run.status}${stats.totalRecords ? ` — ${stats.successRecords ?? "?"}/${stats.totalRecords} entities` : ""}`);
      return run;
    }
    if (Date.now() - started > timeoutMs) throw new Error("RDF re-projection timed out");
  }
}

/**
 * OpenMetadata writes RDF asynchronously after each change. Wait until the projection is quiet (stable triple count)
 * and the given assets are present; if any is still missing, re-project the whole catalog.
 */
export async function waitForProjection(om: OM, mustHave: string[], log = console.log) {
  const count = async () => Number((await sparql(om, "SELECT (COUNT(*) AS ?n) WHERE { ?s ?p ?o }")).rows[0]?.n ?? 0);
  const missing = async () => {
    const out: string[] = [];
    for (const fqn of mustHave) {
      const r = await sparql(om, `ASK { ?s <https://open-metadata.org/ontology/fullyQualifiedName> ${JSON.stringify(fqn)} }`.replace("ASK", "SELECT (COUNT(*) AS ?n) WHERE"));
      if (Number(r.rows[0]?.n ?? 0) === 0) out.push(fqn);
    }
    return out;
  };
  let prev = -1;
  for (let i = 0; i < 30; i++) {
    const n = await count();
    if (n === prev) break;
    prev = n;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const gone = await missing();
  if (gone.length) {
    log(`  – RDF projection is missing ${gone.join(", ")}; re-projecting the catalog`);
    await reindexRdf(om, log);
  }
}

/** The reasoner services compute inferences on first query; restart Fuseki so they see the latest catalog. */
export async function refreshReasoners(log = console.log) {
  if (!/localhost|127\.0\.0\.1/.test(FUSEKI)) return;
  const r = spawnSync("docker", ["restart", "openmetadata_fuseki"], { encoding: "utf8" });
  if (r.status !== 0) return log(`  – could not restart Fuseki (${r.stderr.trim()}); restart it to refresh inferences`);
  for (let i = 0; i < 60; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    if ((await fetch(`${FUSEKI}/$/ping`).catch(() => null))?.ok) return log("  ✓ reasoners refreshed (RDFS + OWL Micro)");
  }
  log("  – Fuseki did not come back within 2 minutes");
}

// ---------------------------------------------------------------------------------------------- Wisteria ontology graph

export const ONTOLOGY_GRAPH = "http://example.org/wisteria/ontology";
const ENTITY = "https://open-metadata.org/entity/";
const SKOS_MATCH: Record<string, string> = {
  EXACT_MATCH: "skos:exactMatch",
  CLOSE_MATCH: "skos:closeMatch",
  BROAD_MATCH: "skos:broadMatch",
  NARROW_MATCH: "skos:narrowMatch",
  RELATED_MATCH: "skos:relatedMatch",
};
const lit = (s: string) => JSON.stringify(s);

/**
 * OpenMetadata projects glossary terms, typed relations and lineage, but keeps the is-a hierarchy and
 * concept mappings as JSON. This loads the TBox the reasoner needs into its own named graph:
 * OWL classes with rdfs:subClassOf, SKOS matches to schema.org / FIBO, inverse object properties, and
 * wst:dependsOn — a transitive super-property of om:upstream.
 */
export async function loadOntologyGraph(om: OM, log = console.log) {
  const { CONCEPTS, NS, RELATION_TYPES } = await import("./ontology.ts");
  const { termFqn } = await import("./catalog.ts");
  const termIri = new Map<string, string>();
  for (const c of CONCEPTS) {
    const t = await om.byName<any>("glossaryTerms", termFqn(c.name));
    if (t) termIri.set(c.name, `${ENTITY}glossaryTerm/${t.id}`);
  }
  const triples: string[] = [
    `<${ONTOLOGY_GRAPH}> a owl:Ontology ; rdfs:label "Wisteria ontology" ; rdfs:comment "Business concepts of Wisteria Group, mapped to schema.org, FIBO, W3C ORG and FOAF; governed in OpenMetadata." .`,
    `wst:dependsOn a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:label "depends on" ; rdfs:comment "Transitive closure of lineage: an asset depends on everything upstream of it." .`,
    `om:upstream rdfs:subPropertyOf wst:dependsOn .`,
  ];
  for (const c of CONCEPTS) {
    const cls = `<${NS}${c.name}>`;
    const term = termIri.get(c.name);
    triples.push(`${cls} a owl:Class ; rdfs:label ${lit(c.displayName)} ; skos:definition ${lit(c.description)} ${term ? `; rdfs:isDefinedBy <${term}>` : ""} .`);
    if (term) triples.push(`<${term}> a owl:Class ; owl:equivalentClass ${cls} .`);
    if (c.parent) {
      triples.push(`${cls} rdfs:subClassOf <${NS}${c.parent}> .`);
      if (term && termIri.get(c.parent)) triples.push(`<${term}> rdfs:subClassOf <${termIri.get(c.parent)}> .`);
    }
    for (const [iri, type] of c.mappings ?? []) {
      triples.push(`${cls} ${SKOS_MATCH[type]} <${iri}> .`);
      if (term) triples.push(`<${term}> ${SKOS_MATCH[type]} <${iri}> .`);
    }
  }
  for (const r of RELATION_TYPES) {
    triples.push(`<${r.predicate}> a owl:ObjectProperty ; rdfs:label ${lit(r.displayName)} ; rdfs:comment ${lit(r.description)} ; owl:inverseOf <${r.inversePredicate}> .`);
    triples.push(`<${r.inversePredicate}> a owl:ObjectProperty ; rdfs:label ${lit(r.inverseDisplayName)} .`);
  }
  const prefixes = `PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX om: <https://open-metadata.org/ontology/> PREFIX wst: <${NS}>`;
  await om.req("POST", "/rdf/sparql/update", { query: `${prefixes}\nDROP SILENT GRAPH <${ONTOLOGY_GRAPH}> ;\nINSERT DATA { GRAPH <${ONTOLOGY_GRAPH}> {\n${triples.join("\n")}\n} }` });
  log(`  ✓ Wisteria ontology graph: ${CONCEPTS.length} OWL classes, ${RELATION_TYPES.length * 2} object properties, transitive wst:dependsOn (${triples.length} statements)`);
}

const PREFIXES: Array<[string, string]> = [
  ["https://open-metadata.org/ontology/", "om:"],
  ["https://open-metadata.org/entity/", "omx:"],
  ["http://example.org/wisteria#", "wst:"],
  ["https://schema.org/", "schema:"],
  ["https://spec.edmcouncil.org/fibo/ontology/", "fibo:"],
  ["http://www.w3.org/2004/02/skos/core#", "skos:"],
  ["http://www.w3.org/ns/prov#", "prov:"],
  ["http://www.w3.org/ns/org#", "org:"],
  ["http://xmlns.com/foaf/0.1/", "foaf:"],
  ["http://www.w3.org/2000/01/rdf-schema#", "rdfs:"],
  ["http://www.w3.org/1999/02/22-rdf-syntax-ns#", "rdf:"],
];
export const shorten = (v: string) => {
  for (const [iri, p] of PREFIXES) if (v.startsWith(iri)) return p + v.slice(iri.length);
  return v;
};
