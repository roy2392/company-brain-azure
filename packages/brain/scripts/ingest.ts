/**
 * Era (Wisteria Group) → MongoDB Atlas.
 *   npm run ingest                      # all connectors that have a token
 *   npm run ingest -- slack gong        # only these (Salesforce always runs first: it defines accounts)
 *   npm run ingest -- --fresh           # ignore the on-disk Era cache
 * Afterwards: npm run om:setup  (catalog sources, Atlas collections and lineage in OpenMetadata)
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { cfg, type EraConnector } from "../src/config.ts";
import { getEmbedder } from "../src/brain/embed.ts";
import { AccountMatcher, slug } from "../src/brain/entities.ts";
import { indexOutput } from "../src/brain/indexer.ts";
import { closeDb, colls, ensureIndexes } from "../src/brain/store.ts";
import type { ConnectorOutput } from "../src/brain/types.ts";
import { EraClient } from "../src/era/client.ts";
import { pullAtlassian } from "../src/era/connectors/atlassian.ts";
import { pullDrive } from "../src/era/connectors/drive.ts";
import { pullGong } from "../src/era/connectors/gong.ts";
import { pullSalesforce } from "../src/era/connectors/salesforce.ts";
import { pullSlack } from "../src/era/connectors/slack.ts";
import { pullZendesk } from "../src/era/connectors/zendesk.ts";
import type { PullContext } from "../src/era/util.ts";

const args = process.argv.slice(2);
if (args.includes("--fresh")) rmSync(path.join(cfg.cacheDir, "era"), { recursive: true, force: true });
const only = new Set(args.filter((a) => !a.startsWith("--")));
const want = (c: string) => !only.size || only.has(c);
const log = (m: string) => console.log(m);
const t0 = Date.now();

const sf = new EraClient("salesforce");
if (!sf.configured) {
  console.error("Salesforce token missing — it defines the account universe. Run `npm run era:import` first.");
  process.exit(1);
}

const embedder = await getEmbedder();
log(`▸ Atlas ${cfg.mongo.uri.replace(/\/\/[^@]*@/, "//***@")} db=${cfg.mongo.db} · embeddings: ${embedder ? `${embedder.model} (${embedder.dims}d)` : "off (text search only)"}`);
await ensureIndexes(embedder?.dims ?? null);

const focusNames = (process.env.BRAIN_FOCUS_NAMES ?? "Acacia Partners,Absolis").split(",").map((s) => s.trim()).filter(Boolean);
log("▸ salesforce");
const sfOut = await pullSalesforce(sf, { focusN: cfg.focusAccounts, focusNames, log });
log(`   focus accounts: ${sfOut.focus.map((f) => f.name).join(", ")}`);
const r0 = await indexOutput(sfOut, log);
log(`   ✓ ${r0.docs} docs, ${r0.chunks} chunks, ${r0.entities} entities`);

const ctx: PullContext = {
  log,
  focus: sfOut.focus,
  matcher: new AccountMatcher(sfOut.accounts.map((a) => ({ _id: a.id, name: a.name }))),
  now: sfOut.now,
  sinceDays: Number(process.env.BRAIN_SINCE_DAYS ?? 200),
};
const { meta } = await colls();
await meta.updateOne({ _id: "clock" }, { $set: { now: sfOut.now } }, { upsert: true });
await meta.updateOne({ _id: "focus" }, { $set: { accounts: sfOut.focus } }, { upsert: true });

const accountSlugs = new Map(sfOut.accounts.map((a) => [slug(a.name), a.id]));
const steps: Array<[EraConnector, string, () => Promise<ConnectorOutput>]> = [
  ["slack", "slack", () => pullSlack(new EraClient("slack"), ctx, accountSlugs)],
  ["zendesk", "zendesk", () => pullZendesk(new EraClient("zendesk"), ctx)],
  ["gong", "gong", () => pullGong(new EraClient("gong"), ctx)],
  ["jira-confluence", "jira-confluence", () => pullAtlassian(new EraClient("jira-confluence"), ctx)],
  ["google-drive", "google-drive", () => pullDrive(new EraClient("google-drive"), ctx)],
];
for (const [connector, label, run] of steps) {
  if (!want(label)) continue;
  if (!new EraClient(connector).configured) {
    log(`– ${label}: no token, skipped`);
    continue;
  }
  log(`▸ ${label}`);
  try {
    const out = await run();
    const r = await indexOutput(out, log);
    log(`   ✓ ${r.docs} docs, ${r.chunks} chunks, ${r.entities} entities`);
  } catch (e) {
    log(`   ✗ ${label} failed: ${String(e).slice(0, 300)}`);
  }
}

// the clock is the latest event across every system
const { docs } = await colls();
const latest = await docs.find({}, { projection: { ts: 1 } }).sort({ ts: -1 }).limit(1).next();
if (latest) await meta.updateOne({ _id: "clock" }, { $set: { now: latest.ts } }, { upsert: true });
log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s · brain "today" = ${latest?.ts.toISOString().slice(0, 10)} · next: npm run om:setup`);
await closeDb();
