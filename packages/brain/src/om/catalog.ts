import type { Document } from "mongodb";
import { cfg } from "../config.ts";
import { colls } from "../brain/store.ts";
import { BRAIN_TOOLS } from "../brain/tools.ts";
import type { Source } from "../brain/types.ts";
import { OM, OMError, ref, type Ref } from "./client.ts";
import { CONCEPTS, GLOSSARY, METRICS, NS, RELATION_TYPES, STATEMENTS, type Domain, type Team } from "./ontology.ts";
import { BRAIN_COLLECTIONS, DOCS_TO_CHUNKS, ERA_OBJECTS, type ColSpec, type EraObject } from "./schemas.ts";
import { OM_MCP_READ_TOOLS, OM_MCP_URL, OM_MCP_WRITE_TOOLS } from "./mcp.ts";

/**
 * OpenMetadata is the brain's map: what words mean (ontology), who owns what, and where every
 * answer's data comes from (lineage down to columns). Idempotent: PUT = create-or-update.
 */

export { GLOSSARY };
export const ATLAS_SERVICE = "wisteria_atlas";
export const PIPELINE_SERVICE = "brain_pipelines";
export const DATA_PRODUCT = "Customer360Brain";
export const AI_APP = "company_brain_agent";
export const BRAIN_MCP = "wisteria-brain";

const DOMAINS: Array<{ name: Domain; displayName: string; domainType: string; description: string }> = [
  { name: "Sales", displayName: "Sales", domainType: "Source-aligned", description: "Accounts, opportunities, contracts and pipeline — system of record is Salesforce." },
  { name: "CustomerSuccess", displayName: "Customer Success", domainType: "Consumer-aligned", description: "Customer health, renewals and the voice of the customer from Gong calls." },
  { name: "Support", displayName: "Support", domainType: "Source-aligned", description: "Tickets, escalations and SLAs — system of record is Zendesk." },
  { name: "Engineering", displayName: "Engineering", domainType: "Source-aligned", description: "Issues, incidents and technical documentation in Jira and Confluence." },
  { name: "Collaboration", displayName: "Collaboration", domainType: "Source-aligned", description: "Conversations and documents: Slack channels and Google Drive." },
  { name: "CompanyBrain", displayName: "Company Brain", domainType: "Aggregate", description: "The unified Wisteria company brain on MongoDB Atlas: normalized documents, entity graph, hybrid search index and the agent that answers from it." },
];

const TEAMS: Array<{ name: Team; displayName: string; description: string }> = [
  { name: "Sales", displayName: "Sales", description: "Revenue team — owns Salesforce data." },
  { name: "CustomerSuccess", displayName: "Customer Success", description: "Owns customer health, renewals and call intelligence." },
  { name: "Support", displayName: "Support", description: "Owns tickets and escalations." },
  { name: "Engineering", displayName: "Engineering", description: "Owns Jira, Confluence and platform reliability." },
  { name: "Product", displayName: "Product", description: "Owns roadmap, product docs and the product catalog." },
  { name: "Finance", displayName: "Finance", description: "Owns revenue definitions (ARR, bookings, churn)." },
  { name: "DataPlatform", displayName: "Data Platform", description: "Owns the company brain on MongoDB Atlas and the ingestion pipelines." },
];

export const SOURCE_SYSTEMS: Record<Source, { service: string; displayName: string; domain: Domain; team: Team; connector: string }> = {
  salesforce: { service: "era_salesforce", displayName: "Salesforce · Era", domain: "Sales", team: "Sales", connector: "salesforce" },
  zendesk: { service: "era_zendesk", displayName: "Zendesk · Era", domain: "Support", team: "Support", connector: "zendesk" },
  gong: { service: "era_gong", displayName: "Gong · Era", domain: "CustomerSuccess", team: "CustomerSuccess", connector: "gong" },
  slack: { service: "era_slack", displayName: "Slack · Era", domain: "Collaboration", team: "DataPlatform", connector: "slack" },
  jira: { service: "era_atlassian", displayName: "Jira & Confluence · Era", domain: "Engineering", team: "Engineering", connector: "jira-confluence" },
  confluence: { service: "era_atlassian", displayName: "Jira & Confluence · Era", domain: "Engineering", team: "Engineering", connector: "jira-confluence" },
  drive: { service: "era_google_drive", displayName: "Google Drive · Era", domain: "Collaboration", team: "Product", connector: "google-drive" },
};

// ---------------------------------------------------------------------------------------------- helpers

export const tolerate = async <T>(p: Promise<T>, codes = [400, 409]): Promise<T | null> => {
  try {
    return await p;
  } catch (e) {
    if (e instanceof OMError && codes.includes(e.status)) return null;
    throw e;
  }
};

const byName = new Map(CONCEPTS.map((c) => [c.name, c]));
/** WisteriaGlossary.Organization.Customer */
export function termFqn(name: string): string {
  const path: string[] = [];
  for (let c = byName.get(name); c; c = c.parent ? byName.get(c.parent) : undefined) path.unshift(c.name);
  if (!path.length) throw new Error(`unknown concept ${name}`);
  return [GLOSSARY, ...path].join(".");
}
const termTag = (name: string) => ({ tagFQN: termFqn(name), source: "Glossary", labelType: "Manual", state: "Confirmed" });
/** table-level PII flag: queryable in OpenMetadata's RDF graph, which projects table tags but not column tags */
const piiTableTag = (columns: Array<{ tags: Array<{ tagFQN: string }> }>) => (columns.some((c) => c.tags.some((t) => t.tagFQN === "PII.Sensitive")) ? [{ tagFQN: "PII.Sensitive", source: "Classification", labelType: "Automated", state: "Confirmed" }] : []);
const PII = { tagFQN: "PII.Sensitive", source: "Classification", labelType: "Automated", state: "Confirmed" };
const PII_COLUMN = /(^|_)(e-?mail|phone|mobile|address|street|ssn|birth|dob)/i;

export async function teamMap(om: OM): Promise<Record<Team, Ref>> {
  const out = {} as Record<Team, Ref>;
  for (const t of TEAMS) out[t.name] = ref(await om.get(`/teams/name/${t.name}`), "team");
  return out;
}

// ---------------------------------------------------------------------------------------------- ontology

export async function setupOntology(om: OM, log = console.log) {
  for (const d of DOMAINS) await om.put("/domains", d);
  for (const t of TEAMS) await om.put("/teams", { ...t, teamType: "Group" });
  log(`  ✓ ${DOMAINS.length} domains, ${TEAMS.length} teams`);
  const teams = await teamMap(om);

  // 1. relation vocabulary (object properties with inverses, domain/range, RDF predicates)
  const settings = await om.get<any>("/system/settings/glossaryTermRelationSettings");
  const builtIn = (settings.config_value.relationTypes as any[]).filter((r) => r.isSystemDefined);
  const ours = RELATION_TYPES.flatMap((r) => {
    const base = { isSymmetric: false, isTransitive: false, isFunctional: false, isInverseFunctional: false, isReflexive: false, isIrreflexive: true, isAsymmetric: true, isCrossGlossaryAllowed: true, isSystemDefined: false, category: r.category, color: r.color };
    return [
      { ...base, name: r.name, displayName: r.displayName, description: r.description, inverseRelation: r.inverse, rdfPredicate: r.predicate, domain: r.domain.map(termFqn), range: r.range.map(termFqn) },
      { ...base, name: r.inverse, displayName: r.inverseDisplayName, description: `Inverse of “${r.displayName}”.`, inverseRelation: r.name, rdfPredicate: r.inversePredicate, domain: r.range.map(termFqn), range: r.domain.map(termFqn) },
    ];
  });
  await om.put("/system/settings", { config_type: "glossaryTermRelationSettings", config_value: { relationTypes: [...builtIn, ...ours] } });
  log(`  ✓ ${ours.length} Wisteria relation types (${RELATION_TYPES.map((r) => r.name).join(", ")} + inverses)`);

  // 2. glossary as an is-a hierarchy (rebuild once if an older flat layout exists)
  const flat = await om.byName("glossaryTerms", `${GLOSSARY}.Customer`);
  if (flat) {
    await om.req("DELETE", `/glossaries/name/${GLOSSARY}?hardDelete=true&recursive=true`);
    log("  – removed the earlier flat glossary to rebuild it as an ontology");
  }
  await om.put("/glossaries", {
    name: GLOSSARY,
    displayName: "Wisteria Business Glossary",
    description: `The Wisteria ontology: business concepts as an is-a hierarchy, typed relations between them and mappings to schema.org, FIBO, W3C ORG and FOAF. The company brain uses these definitions when it answers, so every agent speaks the same language. Namespace: \`${NS}\`.`,
    owners: [teams.DataPlatform],
  });
  const terms = new Map<string, any>();
  for (const c of CONCEPTS) {
    const t = await om.put("/glossaryTerms", {
      glossary: GLOSSARY,
      ...(c.parent ? { parent: termFqn(c.parent) } : {}),
      name: c.name,
      displayName: c.displayName,
      description: c.description,
      iri: `${NS}${c.name}`,
      synonyms: c.synonyms ?? [],
      conceptMappings: (c.mappings ?? []).map(([conceptIri, mappingType]) => ({ conceptIri, mappingType, source: conceptIri.includes("edmcouncil") ? "FIBO" : conceptIri.includes("schema.org") ? "schema.org" : conceptIri.includes("ns/org") ? "W3C ORG" : "FOAF" })),
      owners: [teams[c.team]],
      domains: [c.domain],
      tags: c.kind === "metric" ? [{ tagFQN: "Tier.Tier1", source: "Classification", labelType: "Manual", state: "Confirmed" }] : [],
    });
    // 2.0.5 ignores iri/conceptMappings on create-or-update; a JSON Patch persists them
    const mappings = (c.mappings ?? []).map(([conceptIri, mappingType]) => ({ conceptIri, mappingType, source: conceptIri.includes("edmcouncil") ? "FIBO" : conceptIri.includes("schema.org") ? "schema.org" : conceptIri.includes("ns/org") ? "W3C ORG" : "FOAF" }));
    terms.set(c.name, await om.patch(`/glossaryTerms/${t.id}`, [{ op: "add", path: "/iri", value: `${NS}${c.name}` }, { op: "add", path: "/conceptMappings", value: mappings }]));
  }
  log(`  ✓ ${CONCEPTS.length} concepts in ${GLOSSARY} (${CONCEPTS.filter((c) => c.parent).length} with an is-a parent)`);

  // 3. typed statements between concepts
  let ok = 0;
  for (const [s, rel, o] of STATEMENTS) {
    // idempotent: re-posting an existing statement is accepted without creating a duplicate
    const r = await tolerate(om.req("POST", `/glossaryTerms/${terms.get(s).id}/relations`, { relationType: rel, term: { id: terms.get(o).id, type: "glossaryTerm" } }));
    if (r) ok++;
  }
  log(`  ✓ ${ok}/${STATEMENTS.length} ontology statements (inverse edges added by OpenMetadata)`);

  await om.put("/dataProducts", {
    name: DATA_PRODUCT,
    displayName: "Customer 360 Brain",
    description: "Everything Wisteria knows about a customer — CRM, support, calls, conversations, engineering and documents — unified on MongoDB Atlas and served to agents with citations.",
    domains: ["CompanyBrain"],
    owners: [teams.DataPlatform],
  });
}

// ---------------------------------------------------------------------------------------------- columns

function omType(v: unknown): { dataType: string; arrayDataType?: string } {
  if (v instanceof Date) return { dataType: "TIMESTAMP" };
  if (Array.isArray(v)) return { dataType: "ARRAY", arrayDataType: v.length && typeof v[0] === "object" ? "JSON" : typeof v[0] === "number" ? "DOUBLE" : "STRING" };
  switch (typeof v) {
    case "number":
      return { dataType: Number.isInteger(v) ? "BIGINT" : "DOUBLE" };
    case "boolean":
      return { dataType: "BOOLEAN" };
    case "object":
      return { dataType: v === null ? "STRING" : "JSON" };
    case "string":
      return { dataType: /^\d{4}-\d{2}-\d{2}T/.test(v) ? "TIMESTAMP" : v.length > 500 ? "TEXT" : "STRING" };
    default:
      return { dataType: "STRING" };
  }
}

export function toOmColumn(name: string, t: { dataType: string; arrayDataType?: string }, spec?: ColSpec) {
  const tags = [...(spec?.pii || PII_COLUMN.test(name) ? [PII] : []), ...(spec?.term ? [termTag(spec.term)] : [])];
  return {
    name,
    dataType: t.dataType,
    dataTypeDisplay: t.arrayDataType ? `array<${t.arrayDataType.toLowerCase()}>` : t.dataType.toLowerCase(),
    ...(t.arrayDataType ? { arrayDataType: t.arrayDataType } : {}),
    ...(spec?.description ? { description: spec.description } : {}),
    tags,
  };
}

/** Columns from real samples when there are any (spec adds descriptions, concepts, PII), else from the spec. */
export function inferColumns(samples: Document[], spec: ColSpec[] = []) {
  const specBy = new Map(spec.map((s) => [s.name, s]));
  if (!samples.length) return spec.map((s) => toOmColumn(s.name, { dataType: s.type, arrayDataType: s.type === "ARRAY" ? (s.arrayOf ?? "STRING") : undefined }, s));
  const seen = new Map<string, unknown>();
  for (const d of samples) for (const [k, v] of Object.entries(d)) if (!seen.has(k) || seen.get(k) == null) seen.set(k, v);
  return [...seen.entries()].slice(0, 250).map(([name, v]) => toOmColumn(name, omType(v), specBy.get(name)));
}

const rawSpec = (o: EraObject): ColSpec[] => {
  const base = o.rawOnly ? o.columns.filter((c) => o.rawOnly!.includes(c.name)) : o.columns;
  return [{ name: "_id", type: "STRING", description: `Source id (${o.key})` }, ...base, ...(o.rawExtra ?? []), { name: "_brain", type: "JSON", description: "Ingestion metadata (fetchedAt)" }];
};

async function ensureContainer(om: OM, service: string, db: string, schema: string, owners: Ref[], domains: string[], description?: string) {
  await om.put("/databases", { name: db, service, owners, domains });
  await om.put("/databaseSchemas", { name: schema, database: `${service}.${db}`, owners, domains, ...(description ? { description } : {}) });
  return `${service}.${db}.${schema}`;
}

const sourceSchemaFqn = (o: EraObject) => `${SOURCE_SYSTEMS[o.source].service}.wisteria.${o.source}`;
const sourceTableFqn = (o: EraObject) => `${sourceSchemaFqn(o)}.${o.object}`;

// ---------------------------------------------------------------------------------------------- Era sources

/** One OpenMetadata service per Era system; one table per vendor object; keys → ER diagram. */
export async function registerEraSources(om: OM, log = console.log) {
  const teams = await teamMap(om);
  const { raw } = await colls();
  const services = new Set<string>();
  let fromData = 0;
  for (const o of ERA_OBJECTS) {
    const sys = SOURCE_SYSTEMS[o.source];
    if (!services.has(sys.service)) {
      await om.put("/services/databaseServices", {
        name: sys.service,
        displayName: sys.displayName,
        serviceType: "CustomDatabase",
        description: `Wisteria Group's ${sys.displayName.split(" ·")[0]} as served by Era by Eon — read-only connector \`${sys.connector}-mcp.era.eon.io\` (REST + MCP). Tables follow the vendor's public API; columns are refined from real records after ingestion.`,
        connection: { config: { type: "CustomDatabase", sourcePythonClass: `era.${sys.connector}` } },
        owners: [teams[sys.team]],
        domains: [sys.domain],
      });
      services.add(sys.service);
    }
    await ensureContainer(om, sys.service, "wisteria", o.source, [teams[sys.team]], [sys.domain]);
    const samples = await raw(o.collection).find({}, { projection: { _brain: 0, _id: 0, account: 0, comments: 0, extensive: 0, channel: 0, channel_id: 0, contentRead: 0 } }).limit(100).toArray();
    if (samples.length) fromData++;
    const columns = inferColumns(o.rawOnly && samples.length ? samples.map((s) => ({ ...s, ...(s.fields ?? {}) })) : samples, o.columns).filter((c) => c.name !== "fields" && c.name !== "self");
    await om.put("/tables", {
      name: o.object,
      databaseSchema: sourceSchemaFqn(o),
      description: o.description,
      tableType: "Regular",
      columns,
      tags: [termTag(o.concept), ...piiTableTag(columns)],
      owners: [teams[sys.team]],
      domains: [sys.domain],
    });
  }
  // keys in a second pass: referenced tables must exist
  for (const o of ERA_OBJECTS) {
    const t = await om.byName("tables", sourceTableFqn(o), "columns");
    const cols = new Set((t.columns ?? []).map((c: any) => c.name));
    const constraints: any[] = cols.has(o.key) ? [{ constraintType: "PRIMARY_KEY", columns: [o.key] }] : [];
    for (const [col, refObj, refCol] of o.fks ?? []) {
      const target = ERA_OBJECTS.find((x) => x.source === o.source && x.object === refObj);
      if (target && cols.has(col)) constraints.push({ constraintType: "FOREIGN_KEY", columns: [col], referredColumns: [`${sourceTableFqn(target)}.${refCol}`], relationshipType: "MANY_TO_ONE" });
    }
    if (constraints.length) await tolerate(om.patch(`/tables/${t.id}`, [{ op: "add", path: "/tableConstraints", value: constraints }]));
  }
  log(`  ✓ ${services.size} Era services, ${ERA_OBJECTS.length} source tables (${fromData} refined from ingested records), keys + foreign keys`);
}

// ---------------------------------------------------------------------------------------------- Atlas

export async function atlasSchemaFqn(om: OM, owners: Ref[], schema = cfg.mongo.db, description = "The Wisteria company brain database on MongoDB Atlas."): Promise<string> {
  const dbs = await om.get<any>(`/databases?service=${ATLAS_SERVICE}&limit=50`);
  for (const db of dbs.data ?? []) {
    const schemas = await om.get<any>(`/databaseSchemas?database=${encodeURIComponent(db.fullyQualifiedName)}&limit=50`);
    const s = (schemas.data ?? []).find((x: any) => x.name === schema);
    if (s) return s.fullyQualifiedName;
  }
  return ensureContainer(om, ATLAS_SERVICE, "default", schema, owners, ["CompanyBrain"], description);
}

function mergeColumnTags(existing: any[], inferred: any[]) {
  const byName = new Map(inferred.map((c) => [c.name, c]));
  const merged = existing.map(({ fullyQualifiedName, ...col }: any) => {
    const inf = byName.get(col.name);
    const tags = [...(col.tags ?? []), ...(inf?.tags ?? [])];
    return { ...col, description: col.description || inf?.description, tags: tags.filter((t, i) => tags.findIndex((x) => x.tagFQN === t.tagFQN) === i) };
  });
  for (const c of inferred) if (!existing.some((e) => e.name === c.name)) merged.push(c);
  return merged;
}

export async function registerAtlasCollections(om: OM, log = console.log) {
  const teams = await teamMap(om);
  const owners = [teams.DataPlatform];
  await om.put("/services/databaseServices", {
    name: ATLAS_SERVICE,
    displayName: "MongoDB Atlas · Wisteria brain",
    serviceType: "MongoDB",
    description: "The company brain store: raw source collections, normalized docs, entity graph and the hybrid search index (Atlas Search + Vector Search, $rankFusion).",
    connection: { config: { type: "MongoDB", scheme: "mongodb", hostPort: "atlas:27017", connectionOptions: { directConnection: "true" } } },
    owners,
    domains: ["CompanyBrain"],
  });
  const schemaFqn = await atlasSchemaFqn(om, owners);
  const c = await colls();
  const all: Array<{ name: string; description: string; concepts: string[]; spec: ColSpec[] }> = [
    ...ERA_OBJECTS.map((o) => ({ name: o.collection, description: `Raw ${SOURCE_SYSTEMS[o.source].displayName.split(" ·")[0]} \`${o.object}\` records, verbatim from Era. ${o.description}`, concepts: [o.concept], spec: rawSpec(o) })),
    ...BRAIN_COLLECTIONS.map((b) => ({ name: b.name, description: b.description, concepts: b.concepts, spec: b.columns })),
  ];
  for (const t of all) {
    const samples = await c.raw(t.name).find({}, { projection: { embedding: 0 } }).limit(100).toArray();
    const existing = await om.byName("tables", `${schemaFqn}.${t.name}`, "columns");
    const columns = inferColumns(samples, t.spec);
    if (t.name === "chunks" && samples.length) columns.push(toOmColumn("embedding", { dataType: "ARRAY", arrayDataType: "DOUBLE" }, t.spec.find((s) => s.name === "embedding")));
    await om.put("/tables", {
      name: t.name,
      databaseSchema: schemaFqn,
      description: t.description,
      tableType: "Regular",
      columns: existing?.columns?.length ? mergeColumnTags(existing.columns, columns) : columns,
      tableConstraints: [{ constraintType: "PRIMARY_KEY", columns: ["_id"] }],
      tags: [...t.concepts.map(termTag), ...piiTableTag(existing?.columns?.length ? mergeColumnTags(existing.columns, columns) : columns)],
      owners,
      domains: ["CompanyBrain"],
      dataProducts: [DATA_PRODUCT],
    });
  }
  log(`  ✓ ${all.length} Atlas collections cataloged under ${schemaFqn}`);
  return schemaFqn;
}

// ---------------------------------------------------------------------------------------------- metrics + AI assets

export async function setupMetrics(om: OM, schemaFqn: string, log = console.log) {
  const teams = await teamMap(om);
  for (const m of METRICS) {
    await om.put("/metrics", {
      name: m.name,
      displayName: m.displayName,
      description: m.description,
      metricType: m.metricType,
      unitOfMeasurement: m.unit,
      ...(m.unit === "OTHER" ? { customUnitOfMeasurement: "evidence-backed assessment" } : {}),
      ...(m.granularity ? { granularity: m.granularity } : {}),
      metricExpression: { language: m.language, code: m.code },
      tags: [termTag(m.term)],
      owners: [teams[m.team]],
      // metrics live in their business domain; data products must match the asset's domain
      domains: [m.domain],
    });
  }
  log(`  ✓ ${METRICS.length} governed metrics (${METRICS.map((m) => m.displayName).join(", ")})`);
}

export async function setupAiAssets(om: OM, schemaFqn: string, log = console.log) {
  const teams = await teamMap(om);
  const owners = [teams.DataPlatform];
  const domains = ["CompanyBrain"];

  // pipelines that move and index the data
  await om.put("/services/pipelineServices", { name: PIPELINE_SERVICE, displayName: "Company Brain pipelines", serviceType: "CustomPipeline", description: "TypeScript ingestion that pulls Era (Wisteria) systems into MongoDB Atlas and builds the brain index.", connection: { config: { type: "CustomPipeline" } }, owners });
  await om.put("/pipelines", {
    name: "era_to_atlas", displayName: "Era → Atlas ingestion", service: PIPELINE_SERVICE, owners, domains,
    description: "Pulls a scoped slice of every Era connector (vendor-shaped REST, cached on disk) into `raw_*` collections in MongoDB Atlas. Salesforce runs first and picks the focus accounts.",
    tasks: ["salesforce", "slack", "zendesk", "gong", "jira-confluence", "google-drive"].map((s) => ({ name: `ingest_${s.replace("-", "_")}`, displayName: `Ingest ${s}`, downstreamTasks: [] })),
  });
  await om.put("/pipelines", {
    name: "brain_indexer", displayName: "Brain indexer", service: PIPELINE_SERVICE, owners, domains,
    description: "Normalizes raw records into citable `docs`, resolves `entities` across systems, chunks and embeds into `chunks` (Atlas Search + Vector Search).",
    tasks: [
      { name: "normalize", displayName: "Normalize to docs", downstreamTasks: ["resolve_entities", "chunk_embed"] },
      { name: "resolve_entities", displayName: "Resolve entities and graph edges", downstreamTasks: [] },
      { name: "chunk_embed", displayName: "Chunk, embed, index", downstreamTasks: [] },
    ],
  });

  // models
  await om.put("/services/llmServices", { name: "anthropic", displayName: "Anthropic", serviceType: "Anthropic", description: "Claude models for the brain agent (Anthropic API or Microsoft Foundry).", owners });
  await om.put("/services/llmServices", { name: "ollama_local", displayName: "Ollama (local)", serviceType: "Ollama", description: "Local embedding models.", owners });
  const claude = await om.put("/llmModels", { name: cfg.agent.model, displayName: "Claude Sonnet", service: "anthropic", baseModel: cfg.agent.model, modelProvider: "Anthropic", description: "Reasoning and tool use for the company brain agent.", governanceStatus: "Approved", owners, domains });
  const embed = await om.put("/llmModels", { name: cfg.embed.ollamaModel, displayName: cfg.embed.ollamaModel, service: "ollama_local", baseModel: cfg.embed.ollamaModel, modelProvider: "Nomic AI", description: "768-dimension text embeddings for Atlas Vector Search (task prefixes search_document / search_query).", governanceStatus: "Approved", owners, domains });

  // MCP servers: the brain's own, plus the Era connectors agents can use directly
  await om.put("/services/mcpServices", { name: "wisteria_mcp", displayName: "Wisteria MCP", serviceType: "Mcp", description: "MCP servers available to Wisteria's agents.", owners });
  const brainMcp = await om.put("/mcpServers", {
    name: BRAIN_MCP, displayName: "Wisteria Company Brain (MCP)", service: "wisteria_mcp", serverType: "DataAccess", transportType: "Stdio", developmentStage: "Development", owners, domains,
    description: "The company brain as an MCP server: hybrid search, account 360, company graph, what changed, governed definitions (OpenMetadata) and record lookup — read-only, always cited.",
    connectionConfig: { command: "npx", args: ["tsx", "packages/brain/src/mcp/server.ts"] },
    tools: BRAIN_TOOLS.map((t) => ({ name: t.name, description: t.description, toolCategory: "DataOperation", riskLevel: "Low", sideEffects: false, idempotent: true, reversible: true })),
    dataAccessSummary: { sensitivityLevel: "Confidential", piiAccess: true, databaseAccess: true, externalApiAccess: true, networkAccess: true, fileSystemAccess: false },
  });
  const omMcp = await om.put("/mcpServers", {
    name: "openmetadata", displayName: "OpenMetadata (MCP)", service: "wisteria_mcp", serverType: "DataAccess", transportType: "StreamableHTTP", developmentStage: "Production", owners, domains,
    description: "OpenMetadata's built-in MCP server. The brain agent connects as the read-only company-brain-bot (DataConsumer role); write tools are blocked in the agent.",
    connectionConfig: { url: OM_MCP_URL },
    tools: [
      ...OM_MCP_READ_TOOLS.map((name) => ({ name, toolCategory: "DataOperation", riskLevel: "Low", sideEffects: false, idempotent: true, reversible: true })),
      ...OM_MCP_WRITE_TOOLS.filter((n) => /^create|^patch/.test(n)).map((name) => ({ name, toolCategory: "DataOperation", riskLevel: "Medium", sideEffects: true, idempotent: false, reversible: true, description: "Blocked for the brain agent" })),
    ],
    dataAccessSummary: { sensitivityLevel: "Internal", piiAccess: false, databaseAccess: false, externalApiAccess: false, networkAccess: true, fileSystemAccess: false },
  });
  for (const [s, sys] of Object.entries(SOURCE_SYSTEMS)) {
    if (s === "confluence") continue;
    await om.put("/mcpServers", {
      name: `era-${sys.connector}`, displayName: `Era ${sys.displayName.split(" ·")[0]}`, service: "wisteria_mcp", serverType: "WebAPI", transportType: "StreamableHTTP", developmentStage: "Production", owners: [teams[sys.team]], domains: [sys.domain],
      description: `Read-only MCP endpoint for Wisteria's ${sys.displayName.split(" ·")[0]} (Era by Eon). Bearer token per environment.`,
      connectionConfig: { url: `https://${sys.connector}-mcp.era.eon.io/mcp/` },
      dataAccessSummary: { sensitivityLevel: "Confidential", piiAccess: true, externalApiAccess: true, networkAccess: true, databaseAccess: false, fileSystemAccess: false },
    });
  }

  // the AI application itself
  const table = async (n: string) => ref(await om.get(`/tables/name/${encodeURIComponent(`${schemaFqn}.${n}`)}`), "table");
  const [docs, chunks, entities] = await Promise.all(["docs", "chunks", "entities"].map(table));
  await om.put("/aiApplications", {
    name: AI_APP, displayName: "Company Brain agent", applicationType: "Agent", developmentStage: "Development", owners, domains, dataProducts: [DATA_PRODUCT],
    description: "Answers questions about Wisteria with citations. Claude Agent SDK loop over the brain tools; retrieval is hybrid ($rankFusion of Atlas Vector Search + Atlas Search) over MongoDB Atlas; definitions, owners and lineage come from OpenMetadata at answer time.",
    primaryModel: cfg.agent.model,
    modelConfigurations: [{ model: ref(claude, "llmModel"), purpose: "Primary" }, { model: ref(embed, "llmModel"), purpose: "Embedding" }],
    tools: [ref(brainMcp, "mcpServer"), ref(omMcp, "mcpServer")],
    dataSources: [docs, entities],
    knowledgeBases: [chunks],
    framework: { name: "Custom", language: "TypeScript" },
    deploymentUrl: "http://localhost:3100",
    sourceCode: "packages/brain/src/agent.ts",
  });
  // retire the pre-2.0 ML model representation of the agent if an older setup created it
  await tolerate(om.req("DELETE", `/mlmodels/name/brain_models.company_brain_agent?hardDelete=true`), [400, 404, 409]);
  await tolerate(om.req("DELETE", `/services/mlmodelServices/name/brain_models?hardDelete=true&recursive=true`), [400, 404, 409]);
  log(`  ✓ AI assets: ${cfg.agent.model} + ${cfg.embed.ollamaModel}, MCP servers (${BRAIN_MCP}, openmetadata, 6 Era), AI application ${AI_APP}`);
}

// ---------------------------------------------------------------------------------------------- lineage

type Cols = Record<string, string[]>;

/** Era table → Atlas raw → docs / entities → chunks → metrics → AI application, with column-level lineage. */
export async function wireLineage(om: OM, schemaFqn: string, log = console.log) {
  const tableCache = new Map<string, any>();
  const table = async (fqn: string) => {
    if (!tableCache.has(fqn)) tableCache.set(fqn, await om.byName("tables", fqn, "columns"));
    return tableCache.get(fqn);
  };
  const ingest = ref(await om.get(`/pipelines/name/${PIPELINE_SERVICE}.era_to_atlas`), "pipeline");
  const indexer = ref(await om.get(`/pipelines/name/${PIPELINE_SERVICE}.brain_indexer`), "pipeline");
  let edges = 0;
  let colEdges = 0;

  const edge = async (from: any, to: any, description: string, pipeline: Ref | undefined, cols: Cols = {}, envelope?: string) => {
    if (!from || !to) return;
    const fromCols = new Set((from.columns ?? []).map((c: any) => c.name));
    const toCols = new Set((to.columns ?? []).map((c: any) => c.name));
    const columnsLineage = Object.entries(cols)
      .filter(([toCol]) => toCols.has(toCol))
      .map(([toCol, fromList]) => ({
        toColumn: `${to.fullyQualifiedName}.${toCol}`,
        fromColumns: [...new Set(fromList.map((f) => (fromCols.has(f) ? f : envelope && fromCols.has(envelope) ? envelope : null)).filter(Boolean))].map((f) => `${from.fullyQualifiedName}.${f}`),
      }))
      .filter((cl) => cl.fromColumns.length);
    colEdges += columnsLineage.length;
    await om.put("/lineage", {
      edge: {
        fromEntity: { id: from.id, type: "table" },
        toEntity: { id: to.id, type: "table" },
        lineageDetails: { description, source: "PipelineLineage", ...(pipeline ? { pipeline: { id: pipeline.id, type: pipeline.type } } : {}), columnsLineage },
      },
    });
    edges++;
  };

  const docs = await table(`${schemaFqn}.docs`);
  const chunks = await table(`${schemaFqn}.chunks`);
  const entities = await table(`${schemaFqn}.entities`);
  for (const o of ERA_OBJECTS) {
    const src = await table(sourceTableFqn(o));
    const raw = await table(`${schemaFqn}.${o.collection}`);
    // source → raw: same-named columns 1:1; fields kept in an API envelope map onto it
    const identity: Cols = Object.fromEntries((raw?.columns ?? []).map((c: any) => [c.name, [c.name]]));
    if (o.rawOnly) identity.fields = o.columns.filter((c) => !o.rawOnly!.includes(c.name)).map((c) => c.name);
    identity._id = [o.key];
    await edge(src, raw, `Era ${o.source} ${o.object} → Atlas ${o.collection} (era_to_atlas)`, ingest, identity);
    if (o.toDocs) await edge(raw, docs, `normalize ${o.object} into citable docs`, indexer, o.toDocs, o.rawOnly ? "fields" : undefined);
    if (o.toEntities) await edge(raw, entities, `resolve ${o.object} into the entity graph`, indexer, o.toEntities, o.rawOnly ? "fields" : undefined);
  }
  await edge(docs, chunks, "chunk + embed (nomic-embed-text) + index", indexer, DOCS_TO_CHUNKS);

  // metrics computed from collections, AI application fed by the brain
  const app = await om.byName("aiApplications", AI_APP);
  let extra = 0;
  for (const m of METRICS) {
    const metric = await om.byName("metrics", m.name);
    if (!metric) continue;
    for (const coll of m.from) {
      const t = await table(`${schemaFqn}.${coll}`);
      if (t && (await tolerate(om.addLineage(ref(t, "table"), ref(metric, "metric"), `computes ${m.displayName}`)))) extra++;
    }
    if (app && (await tolerate(om.addLineage(ref(metric, "metric"), ref(app, "aiApplication"), `${m.displayName} used in answers`)))) extra++;
  }
  if (app) for (const t of [docs, chunks, entities]) if (t && (await tolerate(om.addLineage(ref(t, "table"), ref(app, "aiApplication"), "retrieved by the brain agent")))) extra++;
  log(`  ✓ ${edges} table lineage edges with ${colEdges} column mappings; ${extra} metric/AI edges`);
}

// ---------------------------------------------------------------------------------------------- owners

const TITLE_TEAM: Array<[RegExp, Team]> = [
  [/customer success|\bcs\b|renewal|account management/i, "CustomerSuccess"],
  [/support|service desk/i, "Support"],
  [/sales|revenue|business development|\bsdr\b|\bae\b/i, "Sales"],
  [/data|analytics|platform/i, "DataPlatform"],
  [/engineer|technology|\bcto\b|infrastructure|security|devops|sre/i, "Engineering"],
  [/product|design|\bux\b/i, "Product"],
  [/financ|\bcfo\b|accounting|controller/i, "Finance"],
];
const seniority = (title: string) =>
  /chief|\bc[etfo]o\b|president/i.test(title) ? 4 : /\bvp\b|vice president/i.test(title) ? 3 : /head of/i.test(title) ? 2 : /director/i.test(title) ? 1 : 0;

/** Era's org chart → OpenMetadata users; the most senior leader of each function owns its team. */
export async function importLeaders(om: OM, log = console.log) {
  const { entities } = await colls();
  const people = await entities.find({ type: "person", "attrs.title": { $regex: /chief|\bceo\b|\bcfo\b|\bcto\b|\bvp\b|vice president|head of|director/i } }).limit(300).toArray();
  if (!people.length) return log("  – no Era people with titles yet (needs Slack/Salesforce ingestion)");
  const teams = await teamMap(om);
  const best = new Map<Team, { user: Ref; rank: number }>();
  let created = 0;
  for (const p of people) {
    const title = String(p.attrs.title ?? "");
    const team = TITLE_TEAM.find(([re]) => re.test(title))?.[1];
    const rank = seniority(title);
    if (!team && rank < 4) continue;
    const email = String(p.attrs.email ?? `${p._id.replace(/^person:/, "").replace(/[^a-z0-9.]/gi, ".")}@wisteria.example`).toLowerCase();
    const name = email.split("@")[0].replace(/[^a-z0-9._-]/g, "_").slice(0, 60);
    const user = await tolerate(om.put("/users", { name, email, displayName: p.name, description: title, teams: team ? [teams[team].id] : [] }));
    if (!user) continue;
    created++;
    if (team && rank > (best.get(team)?.rank ?? -1)) best.set(team, { user: ref(user, "user"), rank });
  }
  for (const [team, { user }] of best) {
    await om.patch(`/teams/${teams[team].id}`, [{ op: "add", path: "/owners", value: [{ id: user.id, type: "user" }] }]);
  }
  log(`  ✓ ${created} Era leaders imported as users; ${best.size} teams got an owner`);
}
