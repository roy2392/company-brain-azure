/**
 * Connect agents to OpenMetadata's built-in MCP server (http://localhost:8585/mcp).
 *   npm run om:mcp                 # create the read-only company-brain-bot, store its token in .env, list the tools
 *   npm run om:mcp -- --register   # also add the `openmetadata` MCP server to Claude Code for this project (local scope)
 * The token is written to .env (git-ignored) and never printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOT } from "../src/config.ts";
import { OM } from "../src/om/client.ts";
import { BRAIN_BOT, ensureBrainBotToken, OM_MCP_READ_TOOLS, OM_MCP_URL } from "../src/om/mcp.ts";

const om = await new OM().login();
const token = await ensureBrainBotToken(om);

// .env
const envPath = path.join(ROOT, ".env");
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const line = `OPENMETADATA_MCP_TOKEN=${token}`;
env = /^OPENMETADATA_MCP_TOKEN=.*$/m.test(env) ? env.replace(/^OPENMETADATA_MCP_TOKEN=.*$/m, () => line) : `${env.trimEnd()}\n${line}\n`;
writeFileSync(envPath, env, { mode: 0o600 });
console.log(`✓ ${BRAIN_BOT} token stored in .env (OPENMETADATA_MCP_TOKEN)`);

// probe with the bot's identity
const client = new Client({ name: "wisteria-brain", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(OM_MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
const { tools } = await client.listTools();
const v = client.getServerVersion();
console.log(`✓ ${OM_MCP_URL} → ${v?.name ?? "OpenMetadata MCP"} ${v?.version ?? ""}, ${tools.length} tools (brain agent may use: ${OM_MCP_READ_TOOLS.filter((n) => tools.some((t) => t.name === n)).join(", ")})`);
const lin = await client.callTool({ name: "get_entity_lineage", arguments: { entityType: "table", fqn: "wisteria_atlas.default.wisteria_brain.docs", upstreamDepth: 1, downstreamDepth: 1 } });
const text = (lin.content as Array<{ text?: string }>)[0]?.text ?? "";
console.log(`✓ get_entity_lineage(docs) as ${BRAIN_BOT}: ${lin.isError ? `error — ${text.slice(0, 200)}` : `${text.length} chars of lineage`}`);
await client.close();

if (process.argv.includes("--register")) {
  spawnSync("claude", ["mcp", "remove", "openmetadata", "--scope", "local"], { cwd: ROOT, stdio: "ignore" });
  const r = spawnSync("claude", ["mcp", "add", "openmetadata", "--scope", "local", "--transport", "http", OM_MCP_URL, "--header", `Authorization: Bearer ${token}`], { cwd: ROOT, encoding: "utf8" });
  console.log(r.status === 0 ? `✓ Claude Code: added MCP server "openmetadata" for ${ROOT} (local scope) — start a new session to use it` : `✗ claude mcp add failed: ${r.stderr.trim()}`);
}
