/**
 * SPARQL over OpenMetadata's RDF knowledge graph (Fuseki), through the OpenMetadata API.
 *   npm run sparql                                   # list the demo queries
 *   npm run sparql -- 2                              # run queries/sparql/2-*.rq with its default inference
 *   npm run sparql -- kinds-of-person --inference none
 *   npm run sparql -- 3 --compare                    # same query without and with the reasoner
 *   npm run sparql -- path/to/query.rq
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";
import { OM } from "../src/om/client.ts";
import { shorten, sparql, type Inference } from "../src/om/rdf.ts";

const DIR = path.join(ROOT, "queries", "sparql");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--inference");

const header = (text: string, key: string) => text.match(new RegExp(`^# ${key}:\\s*(.+)$`, "m"))?.[1]?.trim();

if (!target) {
  console.log("Demo queries (npm run sparql -- <number|name> [--inference none|rdfs|owl] [--compare]):\n");
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".rq")).sort()) {
    const q = readFileSync(path.join(DIR, f), "utf8");
    console.log(`  ${f.replace(/\.rq$/, "").padEnd(22)} ${header(q, "title")}  [inference: ${header(q, "inference") ?? "none"}]`);
  }
  process.exit(0);
}

const file = existsSync(target) ? target : readdirSync(DIR).map((f) => path.join(DIR, f)).find((f) => path.basename(f).startsWith(`${target}-`) || path.basename(f).includes(target));
if (!file) {
  console.error(`No query matching "${target}" in ${DIR}`);
  process.exit(1);
}
const query = readFileSync(file, "utf8");
const om = await new OM().login();

function table(vars: string[], rows: Array<Record<string, string>>) {
  const cells = rows.map((r) => vars.map((v) => shorten(r[v] ?? "")));
  // the last column is never truncated (it often holds a list)
  const width = vars.map((v, i) => Math.min(i === vars.length - 1 ? 400 : 60, Math.max(v.length, ...cells.map((c) => c[i].length))));
  const fmt = (vals: string[]) => vals.map((v, i) => (v.length > width[i] ? `${v.slice(0, width[i] - 1)}…` : v.padEnd(width[i]))).join("  ");
  console.log(fmt(vars));
  console.log(width.map((w) => "─".repeat(w)).join("  "));
  for (const c of cells) console.log(fmt(c));
}

const run = async (inference: Inference) => {
  const t0 = Date.now();
  const r = await sparql(om, query, inference);
  return { ...r, ms: Date.now() - t0 };
};

console.log(`\n${header(query, "title")}\n${header(query, "question") ?? ""}\n`);
if (args.includes("--compare")) {
  const level = (header(query, "inference") ?? "rdfs") as Inference;
  const [plain, reasoned] = [await run("none"), await run(level === "none" ? "rdfs" : level)];
  console.log(`inference none → ${plain.rows.length} rows (${plain.ms} ms)   |   inference ${level} → ${reasoned.rows.length} rows (${reasoned.ms} ms)\n`);
  table(reasoned.vars, reasoned.rows);
} else {
  const inference = (flag("--inference") ?? header(query, "inference") ?? "none") as Inference;
  const r = await run(inference);
  table(r.vars, r.rows);
  console.log(`\n${r.rows.length} rows · inference ${inference} · ${r.ms} ms`);
}
