/**
 * Discover what each Era connector exposes: MCP tools (+ input fields) and which
 * vendor-shaped REST endpoints answer. Writes .cache/era/probe/<connector>.json.
 *   npm run era:probe [-- salesforce slack]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cfg, ERA_CONNECTORS, type EraConnector } from "../src/config.ts";
import { EraClient } from "../src/era/client.ts";

const REST_GUESSES: Record<EraConnector, string[]> = {
  salesforce: ["/services/data/", "/services/data/v60.0/sobjects", "/services/data/v60.0/query?q=SELECT+Id,Name+FROM+Account+LIMIT+2"],
  zendesk: ["/api/v2/tickets.json?per_page=2", "/api/v2/organizations.json?per_page=2", "/api/v2/users.json?per_page=2"],
  gong: ["/v2/calls", "/v2/users"],
  slack: ["/api/auth.test", "/api/conversations.list?limit=2", "/api/users.list?limit=2"],
  "jira-confluence": ["/rest/api/3/myself", "/rest/api/3/project/search?maxResults=2", "/rest/api/3/search/jql?jql=order+by+updated&maxResults=2", "/wiki/rest/api/space?limit=2", "/wiki/api/v2/pages?limit=2"],
  "google-drive": ["/drive/v3/about?fields=*", "/drive/v3/files?pageSize=2"],
};

const shape = (v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") {
    if (depth > 2) return "{…}";
    return Object.fromEntries(Object.entries(v).slice(0, 25).map(([k, x]) => [k, shape(x, depth + 1)]));
  }
  return typeof v === "string" ? v.slice(0, 60) : v;
};

const only = process.argv.slice(2) as EraConnector[];
const targets = (Object.keys(ERA_CONNECTORS) as EraConnector[]).filter((c) => !only.length || only.includes(c));

for (const c of targets) {
  const era = new EraClient(c, { cache: false });
  if (!era.configured) {
    console.log(`– ${c}: no token`);
    continue;
  }
  const out: Record<string, unknown> = { connector: c, probedAt: new Date().toISOString() };
  try {
    const client = await era.mcp();
    const { tools } = await client.listTools();
    out.tools = tools.map((t) => ({
      name: t.name,
      description: t.description?.slice(0, 200),
      args: Object.keys((t.inputSchema as any)?.properties ?? {}),
      required: (t.inputSchema as any)?.required ?? [],
    }));
    console.log(`✓ ${c}: ${tools.length} MCP tools — ${tools.map((t) => t.name).join(", ")}`);
  } catch (e) {
    out.mcpError = String(e);
    console.log(`✗ ${c}: MCP ${e}`);
  }
  out.rest = {};
  for (const p of REST_GUESSES[c]) {
    try {
      const data = await era.rest(p);
      (out.rest as any)[p] = { ok: true, shape: shape(data) };
      console.log(`   REST ✓ ${p}`);
    } catch (e: any) {
      (out.rest as any)[p] = { ok: false, error: String(e.message ?? e).slice(0, 200) };
      console.log(`   REST ✗ ${p} (${e.status ?? "?"})`);
    }
  }
  const file = path.join(cfg.cacheDir, "era", "probe", `${c}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(out, null, 2));
  await era.close();
}
