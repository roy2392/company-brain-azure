/**
 * Call one Era MCP tool and print what comes back (full result saved under .cache/era/calls/).
 *   npm run era:call -- zendesk search_tickets '{"query":"type:ticket updated>2026-10-01"}'
 *   npm run era:call -- zendesk search_tickets --schema      # the tool's input schema
 *   ERA_MAX=4000 npm run era:call -- …                       # print more characters
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { cfg, type EraConnector } from "../src/config.ts";
import { EraClient } from "../src/era/client.ts";

const [connector, tool, rawArgs] = process.argv.slice(2);
if (!connector || !tool) {
  console.error("Usage: npm run era:call -- <connector> <tool> ['<json args>' | --schema]");
  process.exit(1);
}
const era = new EraClient(connector as EraConnector, { cache: false });
const client = await era.mcp();
if (rawArgs === "--schema") {
  const { tools } = await client.listTools();
  const t = tools.find((x) => x.name === tool);
  if (!t) console.log(`no tool ${tool}`);
  else {
    const schema = t.inputSchema as { properties?: Record<string, any>; required?: string[] };
    console.log(`${connector}.${tool}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
    for (const [k, v] of Object.entries(schema.properties ?? {}))
      console.log(`    ${k}${schema.required?.includes(k) ? "*" : ""} (${v.type ?? v.anyOf?.map((a: any) => a.type).join("|") ?? ""}${v.enum ? ` ${JSON.stringify(v.enum).slice(0, 80)}` : ""}): ${String(v.description ?? "").replace(/\s+/g, " ").slice(0, 110)}`);
  }
} else {
  const args = rawArgs ? JSON.parse(rawArgs) : {};
  const res = await client.callTool({ name: tool, arguments: args });
  const blocks = (res.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? `[${c.type}]`);
  // many Era tools return one JSON object per content block — save those as one JSON array
  const parsed = blocks.length > 1 ? blocks.map((b) => { try { return JSON.parse(b); } catch { return undefined; } }) : [];
  const text = parsed.length && parsed.every((p) => p !== undefined) ? JSON.stringify(parsed, null, 1) : blocks.join("\n");
  const file = path.join(cfg.cacheDir, "era", "calls", `${connector}-${tool}-${Date.now()}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  const max = Number(process.env.ERA_MAX ?? 2500);
  console.log(`${res.isError ? "ERROR " : ""}${text.length} chars → ${path.relative(cfg.root, file)}\n${text.slice(0, max)}${text.length > max ? "\n…" : ""}`);
}
await era.close();
