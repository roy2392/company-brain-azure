/**
 * Time-lapse: replay Era's latest quarter as a live sync. Each tick moves Era's clock forward (one simulated day by
 * default), pulls what changed in that window through the vendors' own incremental APIs (Zendesk search on `created`,
 * the Zendesk organization audit log, Salesforce SOQL on SystemModstamp), upserts it into the `wisteria_live`
 * database on Atlas, and reflects the tick in OpenMetadata: a pipeline run, row counts (table profile), test results
 * for rows inserted and freshness on Era's clock, sample data, and an activity-feed post when a customer signs or
 * churns. The brain the agents use (`wisteria_brain`) is not touched.
 *   npm run timelapse -- --reset                      # start the quarter over: orgs as they were, no tickets or deals yet
 *   npm run timelapse -- --interval 2 --step-days 1   # seconds per tick, simulated days per tick
 *   npm run timelapse -- --ticks 5                    # stop after five ticks (a rehearsal)
 *   npm run timelapse -- --reset --prepare            # reset and stop: OpenMetadata shows the starting state
 *   options: --from 2026-10-05 --to 2027-01-04 --db wisteria_live --cache (replay Era responses from the disk cache)
 * Needs the Era tokens (on Azure: docker exec --env-file /opt/brain/env/era.env ...; see infra/azure/era-to-vm.sh).
 */
import { MongoClient, type Collection, type Document } from "mongodb";
import { cfg } from "../src/config.ts";
import { EraClient } from "../src/era/client.ts";
import { OM, ref, type Ref } from "../src/om/client.ts";
import { ATLAS_SERVICE, PIPELINE_SERVICE, teamMap, termFqn, tolerate } from "../src/om/catalog.ts";

const arg = (k: string, d = "") => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const DAY = 86_400_000;
const FROM = new Date(`${arg("from", "2026-10-05")}T00:00:00Z`);
const TO = new Date(`${arg("to", "2027-01-04")}T00:00:00Z`);
const STEP = Math.max(1, Math.round(Number(arg("step-days", "1")))) * DAY;
const INTERVAL = Number(arg("interval", "3")) * 1000;
const MAX_TICKS = Number(arg("ticks", "0")) || Infinity;
const LIVE_DB = arg("db", "wisteria_live");
const CACHE = process.argv.includes("--cache");
const SCHEMA = `${ATLAS_SERVICE}.default.${LIVE_DB}`;
const PIPELINE = `${PIPELINE_SERVICE}.era_live_sync`;
const FRESH_HOURS = 72;
const day = (d: Date) => d.toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);

// ------------------------------------------------------------------------------------------- what we keep, per table

type Col = { name: string; dataType: string; arrayDataType?: string; description?: string };
const c = (name: string, dataType: string, description?: string): Col =>
  dataType.startsWith("ARRAY:") ? { name, dataType: "ARRAY", arrayDataType: dataType.slice(6), description } : { name, dataType, description };
interface TableSpec { display: string; source: string; concept: string; task: string; key: string; sortBy: string; inserted?: string; fresh?: string; description: string; columns: Col[] }
const TABLES: Record<string, TableSpec> = {
  zendesk_organizations: {
    display: "Zendesk organizations (live)", source: "era_zendesk.wisteria.zendesk.organizations", concept: "Organization", task: "sync_zendesk_organizations", key: "id", sortBy: "updated_at",
    description: "Customer organizations as of Era's clock: the quarter starts with the 500 that existed, then new customers arrive and churns are applied from the audit log. `lifecycle` comes from the audit log; Era's own `account_status` still says customer after a churn (the records disagree).",
    columns: [c("id", "BIGINT"), c("name", "STRING"), c("domain", "STRING"), c("tier", "STRING"), c("industry", "STRING"), c("plan", "STRING"), c("seats", "INT"), c("arr", "DOUBLE", "Annual recurring revenue, USD"), c("renewal_date", "DATE"), c("account_owner", "STRING"), c("account_status", "STRING", "As Era reports it"), c("lifecycle", "STRING", "active | churned, from the audit log"), c("churned_at", "TIMESTAMP"), c("created_at", "TIMESTAMP"), c("updated_at", "TIMESTAMP"), c("synced_at", "TIMESTAMP", "Wall-clock time of the sync")],
  },
  zendesk_org_events: {
    display: "Customer events (live)", source: "era_zendesk.wisteria.zendesk.organizations", concept: "Organization", task: "sync_zendesk_audit_log", key: "id", sortBy: "created_at", inserted: "created_at",
    description: "Organization changes from the Zendesk audit log, in Era time: customers created, churned and updated.",
    columns: [c("id", "BIGINT"), c("created_at", "TIMESTAMP", "Era time"), c("action", "STRING"), c("change", "STRING"), c("organization_id", "BIGINT"), c("organization", "STRING"), c("arr", "DOUBLE"), c("actor", "STRING"), c("synced_at", "TIMESTAMP")],
  },
  zendesk_tickets: {
    display: "Zendesk tickets this quarter (live)", source: "era_zendesk.wisteria.zendesk.tickets", concept: "SupportTicket", task: "sync_zendesk_tickets", key: "id", sortBy: "created_at", inserted: "created_at", fresh: "created_at",
    description: "Tickets created in the quarter, streamed day by day from Zendesk search (`created>=` / `created<`).",
    columns: [c("id", "BIGINT"), c("created_at", "TIMESTAMP", "Era time"), c("subject", "STRING"), c("status", "STRING"), c("priority", "STRING"), c("type", "STRING"), c("account", "STRING"), c("organization_id", "BIGINT"), c("channel", "STRING"), c("product_area", "STRING"), c("updated_at", "TIMESTAMP"), c("synced_at", "TIMESTAMP")],
  },
  salesforce_opportunities: {
    display: "Salesforce deals this quarter (live)", source: "era_salesforce.wisteria.salesforce.Opportunity", concept: "Opportunity", task: "sync_salesforce_deals", key: "Id", sortBy: "SystemModstamp", inserted: "SystemModstamp", fresh: "SystemModstamp",
    description: "Opportunities created or changed in the quarter, streamed from SOQL on SystemModstamp: deals won, lost and moved.",
    columns: [c("Id", "STRING"), c("SystemModstamp", "TIMESTAMP", "Era time"), c("Name", "STRING"), c("AccountId", "STRING"), c("StageName", "STRING"), c("Amount", "DOUBLE"), c("CloseDate", "DATE"), c("Type", "STRING"), c("IsWon", "BOOLEAN"), c("IsClosed", "BOOLEAN"), c("synced_at", "TIMESTAMP")],
  },
};

// ------------------------------------------------------------------------------------------------- Era (read-only)

const zendesk = new EraClient("zendesk", { cache: CACHE });
const salesforce = new EraClient("salesforce", { cache: CACHE });

async function zendeskPages<T>(path: string, key: string, query: Record<string, unknown>): Promise<T[]> {
  const out: T[] = [];
  let r = await zendesk.rest<any>(path, { query: { per_page: 100, ...query } });
  for (;;) {
    out.push(...(r[key] ?? []));
    if (!r.next_page) return out;
    r = await zendesk.rest<any>(r.next_page);
  }
}
async function soql(q: string): Promise<any[]> {
  const out: any[] = [];
  let r = await salesforce.rest<any>("/services/data/v60.0/query", { query: { q } });
  for (;;) {
    out.push(...(r.records ?? []));
    if (r.done || !r.nextRecordsUrl) return out;
    r = await salesforce.rest<any>(r.nextRecordsUrl);
  }
}
const orgRow = (o: any, now: Date) => {
  const f = o.organization_fields ?? {};
  return { _id: o.id, id: o.id, name: o.name, domain: o.domain_names?.[0] ?? null, tier: f.tier ?? null, industry: f.industry ?? null, plan: f.plan ?? null, seats: f.seats ?? null, arr: f.arr ?? null, renewal_date: f.renewal_date ?? null, account_owner: f.account_owner ?? null, account_status: f.account_status ?? null, lifecycle: "active", churned_at: null, created_at: o.created_at, updated_at: o.updated_at, synced_at: now };
};
const ticketRow = (t: any, now: Date) => ({
  _id: t.id, id: t.id, created_at: t.created_at, subject: t.subject, status: t.status, priority: t.priority, type: t.type,
  account: (t.tags ?? []).find((x: string) => x.startsWith("account_"))?.slice(8) ?? null, organization_id: t.organization_id, channel: t.via?.channel ?? null,
  product_area: (t.custom_fields ?? []).find((f: any) => f.id === 7990001)?.value ?? null, updated_at: t.updated_at, synced_at: now,
});
const DEAL_FIELDS = "Id, Name, AccountId, StageName, Amount, CloseDate, Type, IsWon, IsClosed, SystemModstamp";
const dealRow = (o: any, now: Date) => ({ _id: o.Id, Id: o.Id, SystemModstamp: o.SystemModstamp, Name: o.Name, AccountId: o.AccountId, StageName: o.StageName, Amount: o.Amount, CloseDate: o.CloseDate, Type: o.Type, IsWon: o.IsWon, IsClosed: o.IsClosed, synced_at: now });

// ------------------------------------------------------------------------------------------------ OpenMetadata

const om = new OM();
const ids: Record<string, string> = {};
// test case names carry a run tag set at reset: OpenMetadata keeps incidents by test case name and they outlive a
// hard delete, so a recreated test with the old name trips over the orphaned incident
let RUN = "1";
const testName = (table: string, kind: "rows_inserted" | "freshness") => `${table}_${kind}_${RUN}`;
const testFqn = (table: string, kind: "rows_inserted" | "freshness") => encodeURIComponent(`${SCHEMA}.${table}.${testName(table, kind)}`);
const link = (t: string) => `<#E::table::${SCHEMA}.${t}>`;

async function setupOm(owners: Ref[]) {
  await om.put("/databaseSchemas", { name: LIVE_DB, database: `${ATLAS_SERVICE}.default`, owners, domains: ["CompanyBrain"], description: "Era's latest quarter, replayed as a live sync by `npm run timelapse` (one simulated day per tick)." });
  const pipeline = await om.put("/pipelines", {
    name: "era_live_sync", displayName: "Era → Atlas live sync (time-lapse)", service: PIPELINE_SERVICE, owners, domains: ["CompanyBrain"],
    description: "Replays Era's latest quarter through Zendesk search, the Zendesk audit log and Salesforce SOQL on SystemModstamp, one simulated day per run, into `wisteria_live` on MongoDB Atlas.",
    tasks: Object.values(TABLES).filter((t, i, a) => a.findIndex((x) => x.task === t.task) === i).map((t) => ({ name: t.task, displayName: t.task.replace(/_/g, " ") })),
  });
  // freshness on Era's clock: not one of OpenMetadata's built-in table tests, so it gets its own definition
  await tolerate(om.put("/dataQuality/testDefinitions", {
    name: "tableDataToBeFreshOnEraClock", displayName: "Data freshness (Era clock)", entityType: "TABLE", testPlatforms: ["OpenMetadata"], provider: "user", dataQualityDimension: "Accuracy",
    description: "The newest record is no older than `maxLagHours` relative to the simulated clock of the Era by Eon environment.",
    parameterDefinition: [{ name: "column", dataType: "STRING", required: true }, { name: "maxLagHours", dataType: "INT", required: true }],
  }));
  for (const [name, t] of Object.entries(TABLES)) {
    const table = await om.put("/tables", {
      name, displayName: t.display, databaseSchema: SCHEMA, description: t.description, tableType: "Regular", columns: t.columns,
      tableConstraints: [{ constraintType: "PRIMARY_KEY", columns: [t.key] }], owners, domains: ["CompanyBrain"],
      tags: [{ tagFQN: termFqn(t.concept), source: "Glossary", labelType: "Manual", state: "Confirmed" }],
    });
    ids[name] = table.id;
    const src = await om.byName("tables", t.source);
    if (src) await tolerate(om.addLineage(ref(src, "table"), ref(table, "table"), `${t.task} (time-lapse)`, ref(pipeline, "pipeline")));
    if (t.inserted) await tolerate(om.put("/dataQuality/testCases", {
      name: testName(name, "rows_inserted"), displayName: "Rows inserted per sync", entityLink: link(name), testDefinition: "tableRowInsertedCountToBeBetween",
      parameterValues: [{ name: "min", value: "0" }, { name: "max", value: "5000" }, { name: "columnName", value: t.inserted }, { name: "rangeType", value: "DAY" }, { name: "rangeInterval", value: "1" }],
    }));
    if (t.fresh) await tolerate(om.put("/dataQuality/testCases", {
      name: testName(name, "freshness"), displayName: "Fresh on Era's clock", entityLink: link(name), testDefinition: "tableDataToBeFreshOnEraClock",
      parameterValues: [{ name: "column", value: t.fresh }, { name: "maxLagHours", value: String(FRESH_HOURS) }],
    }));
  }
}

const cell = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : v);
async function reflect(tick: { now: Date; eraNow: Date; started: number; counts: Record<string, number>; added: Record<string, number>; failed: string[] }, colls: Record<string, Collection<Document>>): Promise<string[]> {
  const ts = tick.now.getTime();
  const errors: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${label}: ${String(e).replace(/^Error: /, "").slice(0, 100)}`);
    }
  };
  for (const [name, t] of Object.entries(TABLES)) {
    const rows = await colls[name].find({}, { projection: { _id: 0 } }).sort({ [t.sortBy]: -1 }).limit(12).toArray();
    await step(`${name} profile`, () => om.put(`/tables/${ids[name]}/tableProfile`, { tableProfile: { timestamp: ts, rowCount: tick.counts[name], columnCount: t.columns.length } }));
    await step(`${name} sample`, () => om.put(`/tables/${ids[name]}/sampleData`, { columns: t.columns.map((x) => x.name), rows: rows.map((r) => t.columns.map((x) => cell(r[x.name]))) }));
    if (t.inserted) await step(`${name} rows inserted`, () => om.req("POST", `/dataQuality/testCases/testCaseResults/${testFqn(name, "rows_inserted")}`, {
      timestamp: ts, testCaseStatus: "Success", result: `${tick.added[name]} rows inserted for Era ${day(tick.eraNow)}`, testResultValue: [{ name: "rowCount", value: String(tick.added[name]) }],
    }));
    if (t.fresh) {
      const newest = rows[0]?.[t.fresh] ? new Date(rows[0][t.fresh]) : null;
      const lag = newest ? Math.max(0, Math.round((tick.eraNow.getTime() - newest.getTime()) / 3_600_000)) : null;
      await step(`${name} freshness`, () => om.req("POST", `/dataQuality/testCases/testCaseResults/${testFqn(name, "freshness")}`, {
        timestamp: ts, testCaseStatus: lag !== null && lag <= FRESH_HOURS ? "Success" : "Failed",
        result: lag === null ? "No records yet" : `Newest record ${lag} h behind Era's clock (${day(tick.eraNow)})`, testResultValue: [{ name: "lagHours", value: String(lag ?? -1) }],
      }));
    }
  }
  const tasks = [...new Set(Object.values(TABLES).map((t) => t.task))];
  await step("pipeline run", () => om.put(`/pipelines/${encodeURIComponent(PIPELINE)}/status`, {
    timestamp: ts, executionStatus: tick.failed.length ? "Failed" : "Successful",
    taskStatus: tasks.map((name) => ({ name, executionStatus: tick.failed.includes(name) ? "Failed" : "Successful", startTime: tick.started, endTime: ts })),
  }));
  return errors;
}
const post = (table: string, message: string) => tolerate(om.req("POST", "/feed", { message, about: link(table), type: "Conversation" }), [400, 404, 409]);

// ------------------------------------------------------------------------------------------------------- run

const mongo = await new MongoClient(cfg.mongo.uri).connect();
const db = mongo.db(LIVE_DB);
const colls = Object.fromEntries(Object.keys(TABLES).map((n) => [n, db.collection(n)])) as Record<string, Collection<Document>>;
const meta = db.collection<Document>("_timelapse");
const owners = [(await teamMap(om)).DataPlatform];
const reset = process.argv.includes("--reset") || !(await meta.findOne({ _id: "clock" as any }));
RUN = reset ? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "") : ((await meta.findOne({ _id: "clock" as any }))?.run ?? "1");
if (reset) {
  // a clean slate in OpenMetadata too. Deleting a table drops its profiles, sample data and tests; feed posts and
  // pipeline runs are kept by name and outlive a hard delete, so they are removed one by one first.
  for (const n of Object.keys(TABLES)) {
    for (let i = 0; i < 10; i++) {
      const threads = (await om.req("GET", `/feed?entityLink=${encodeURIComponent(link(n))}&limit=100`).catch(() => null))?.data ?? [];
      if (!threads.length) break;
      for (const th of threads) await tolerate(om.req("DELETE", `/feed/${th.id}`), [400, 404]);
    }
    await tolerate(om.req("DELETE", `/tables/name/${encodeURIComponent(`${SCHEMA}.${n}`)}?hardDelete=true&recursive=true`), [400, 404]);
  }
  for (let i = 0; i < 20; i++) {
    const runs = (await om.req("GET", `/pipelines/${encodeURIComponent(PIPELINE)}/status?startTs=0&endTs=${Date.now()}`).catch(() => null))?.data ?? [];
    if (!runs.length) break;
    for (const r of runs) await tolerate(om.req("DELETE", `/pipelines/${encodeURIComponent(PIPELINE)}/status/${r.timestamp}`), [400, 404]);
  }
  await tolerate(om.req("DELETE", `/pipelines/name/${encodeURIComponent(PIPELINE)}?hardDelete=true`), [400, 404]);
}
await setupOm(owners);

if (reset) {
  for (const n of Object.keys(TABLES)) await colls[n].deleteMany({});
  const now = new Date();
  const orgs = (await zendeskPages<any>("/api/v2/organizations.json", "organizations", {})).filter((o) => new Date(o.created_at) < FROM);
  if (orgs.length) await colls.zendesk_organizations.insertMany(orgs.map((o) => orgRow(o, now)) as any[]);
  await meta.replaceOne({ _id: "clock" as any }, { eraNow: FROM, tick: 0, from: FROM, to: TO, run: RUN }, { upsert: true });
  log(`▸ reset: Era clock at ${day(FROM)} · ${orgs.length} organizations as they were · no tickets or deals yet`);
}
if (process.argv.includes("--prepare")) {
  // the starting state only: OpenMetadata shows the empty live tables, ready for `timelapse.sh start`
  const now = new Date();
  const counts = Object.fromEntries(await Promise.all(Object.keys(TABLES).map(async (n) => [n, await colls[n].countDocuments()]))) as Record<string, number>;
  const errors = await reflect({ now, eraNow: FROM, started: now.getTime(), counts, added: Object.fromEntries(Object.keys(TABLES).map((n) => [n, 0])), failed: [] }, colls);
  if (errors.length) log(`  OpenMetadata: ${errors.join(" · ")}`);
  log(`▸ prepared at Era ${day(FROM)}: ${counts.zendesk_organizations} organizations, nothing streamed yet`);
  await mongo.close();
  process.exit(0);
}
const audits = (await zendesk.rest<any>("/api/v2/audit_logs.json", { query: { "filter[source_type]": "organization" } })).audit_logs ?? [];
const clock = (await meta.findOne({ _id: "clock" as any }))!;
let eraNow = new Date(clock.eraNow);
let tick = clock.tick as number;
const total = Math.ceil((TO.getTime() - FROM.getTime()) / STEP);
log(`▸ streaming Era ${day(eraNow)} → ${day(TO)}: ${total - tick} ticks of ${STEP / DAY} day(s), every ${INTERVAL / 1000}s · ${CACHE ? "Era responses from the disk cache" : "live Era calls"}`);

while (eraNow < TO && tick < (clock.tick as number) + MAX_TICKS) {
  const started = Date.now();
  const t0 = eraNow, t1 = new Date(Math.min(eraNow.getTime() + STEP, TO.getTime()));
  const now = new Date();
  const added: Record<string, number> = Object.fromEntries(Object.keys(TABLES).map((n) => [n, 0]));
  const failed: string[] = [];
  const notes: string[] = [];
  // customers: audit-log events in the window → create, churn, update
  try {
    for (const a of audits.filter((x: any) => new Date(x.created_at) >= t0 && new Date(x.created_at) < t1)) {
      const org = (await zendesk.rest<any>(`/api/v2/organizations/${a.source_id}.json`).catch(() => null))?.organization;
      const row = org ? orgRow(org, now) : null;
      if (a.change_description === "Customer churned") {
        await colls.zendesk_organizations.updateOne({ _id: a.source_id }, { $set: { ...(row ?? {}), lifecycle: "churned", churned_at: a.created_at, synced_at: now } }, { upsert: true });
        notes.push(`${a.source_label} churned`);
        await post("zendesk_org_events", `Era sync · ${day(new Date(a.created_at))}: **${a.source_label}** churned${row?.arr ? ` (${row.tier}, ARR $${Number(row.arr).toLocaleString("en-US")})` : ""}. Zendesk still lists it as \`${row?.account_status ?? "?"}\`.`);
      } else if (row) {
        const prior = await colls.zendesk_organizations.findOne({ _id: a.source_id });
        await colls.zendesk_organizations.replaceOne({ _id: a.source_id }, { ...row, lifecycle: prior?.lifecycle ?? "active", churned_at: prior?.churned_at ?? null }, { upsert: true });
        if (a.action === "create") {
          notes.push(`${a.source_label} signed`);
          await post("zendesk_org_events", `Era sync · ${day(new Date(a.created_at))}: new customer **${a.source_label}**${row.arr ? ` (${row.tier}, ARR $${Number(row.arr).toLocaleString("en-US")})` : ""}.`);
        }
      }
      await colls.zendesk_org_events.replaceOne({ _id: a.id }, { _id: a.id, id: a.id, created_at: a.created_at, action: a.action, change: a.change_description, organization_id: a.source_id, organization: a.source_label, arr: row?.arr ?? null, actor: a.actor_name, synced_at: now }, { upsert: true });
      added.zendesk_org_events++;
    }
  } catch (e) {
    failed.push("sync_zendesk_audit_log", "sync_zendesk_organizations");
    notes.push(`audit log failed: ${String(e).slice(0, 80)}`);
  }
  // tickets created in the window
  try {
    const tickets = await zendeskPages<any>("/api/v2/search.json", "results", { query: `type:ticket created>=${day(t0)} created<${day(t1)}` });
    if (tickets.length) await colls.zendesk_tickets.bulkWrite(tickets.map((t) => ({ replaceOne: { filter: { _id: t.id }, replacement: ticketRow(t, now), upsert: true } })) as any[], { ordered: false });
    added.zendesk_tickets = tickets.length;
  } catch (e) {
    failed.push("sync_zendesk_tickets");
    notes.push(`tickets failed: ${String(e).slice(0, 80)}`);
  }
  // deals created or changed in the window
  try {
    const deals = await soql(`SELECT ${DEAL_FIELDS} FROM Opportunity WHERE SystemModstamp >= ${t0.toISOString()} AND SystemModstamp < ${t1.toISOString()}`);
    const before = await colls.salesforce_opportunities.countDocuments({ _id: { $in: deals.map((d) => d.Id) } as any });
    if (deals.length) await colls.salesforce_opportunities.bulkWrite(deals.map((d) => ({ replaceOne: { filter: { _id: d.Id }, replacement: dealRow(d, now), upsert: true } })) as any[], { ordered: false });
    added.salesforce_opportunities = deals.length - before;
    const won = deals.filter((d) => d.IsWon), lost = deals.filter((d) => d.IsClosed && !d.IsWon);
    if (won.length || lost.length) notes.push(`deals ${won.length} won ($${Math.round(won.reduce((s, d) => s + (d.Amount ?? 0), 0) / 1000)}K) / ${lost.length} lost`);
  } catch (e) {
    failed.push("sync_salesforce_deals");
    notes.push(`deals failed: ${String(e).slice(0, 80)}`);
  }
  eraNow = t1;
  tick++;
  const counts = Object.fromEntries(await Promise.all(Object.keys(TABLES).map(async (n) => [n, await colls[n].countDocuments()]))) as Record<string, number>;
  const churned = await colls.zendesk_organizations.countDocuments({ lifecycle: "churned" });
  const omErrors = await reflect({ now: new Date(), eraNow, started, counts, added, failed }, colls);
  if (omErrors.length) notes.push(`OpenMetadata: ${omErrors.length} failed (${omErrors[0]})`);
  await meta.updateOne({ _id: "clock" as any }, { $set: { eraNow, tick, updatedAt: new Date(), counts, churned } });
  log(`[${String(tick).padStart(3)}/${total}] Era ${day(t0)} · +${added.zendesk_tickets} tickets (${counts.zendesk_tickets}) · deals ${counts.salesforce_opportunities} · customers ${counts.zendesk_organizations - churned} active, ${churned} churned${notes.length ? " · " + notes.join(" · ") : ""} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const wait = INTERVAL - (Date.now() - started);
  if (wait > 0 && eraNow < TO) await sleep(wait);
}
log(eraNow >= TO ? `✓ quarter streamed: Era clock at ${day(eraNow)}` : `▸ paused at Era ${day(eraNow)} (tick ${tick}); run again to continue, or --reset to start over`);
await mongo.close();
