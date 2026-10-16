/**
 * Import Era connector tokens without ever printing them.
 *
 *   1. Era console → Connect → create token → copy the six `claude mcp add ...` commands.
 *   2. npm run era:import              # reads the clipboard, writes ERA_*_TOKEN into .env
 *      npm run era:import -- --register  # also adds the six MCP servers to Claude Code (user scope)
 *      pbpaste | npm run era:import -- --stdin
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ERA_CONNECTORS, ROOT, type EraConnector } from "../src/config.ts";

const args = new Set(process.argv.slice(2));
const input = args.has("--stdin")
  ? readFileSync(0, "utf8")
  : execFileSync("pbpaste", { encoding: "utf8" });

// claude mcp add <name> --scope user --transport http https://<svc>-mcp.era.eon.io/mcp/ --header 'Authorization: Bearer <token>'
const re =
  /claude mcp add (\S+)[^\n]*?(https:\/\/([a-z-]+)-mcp\.era\.eon\.io\/mcp\/?)\s+--header\s+'Authorization:\s*Bearer\s+([^']+)'/g;

const found = new Map<EraConnector, { name: string; url: string; token: string }>();
for (const m of input.matchAll(re)) {
  const [, name, url, svc, token] = m;
  if (!(svc in ERA_CONNECTORS)) continue;
  if (token.includes("…") || token.length < 20) {
    console.error(`✗ ${svc}: token looks truncated — copy the full command from the Era console`);
    continue;
  }
  found.set(svc as EraConnector, { name, url, token });
}

if (found.size === 0) {
  console.error("No Era `claude mcp add` commands found in the input. Copy them from the Era console first.");
  process.exit(1);
}

const envPath = path.join(ROOT, ".env");
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : readFileSync(path.join(ROOT, ".env.example"), "utf8");
for (const [svc, { token }] of found) {
  const key = ERA_CONNECTORS[svc];
  const line = `${key}=${token}`;
  env = new RegExp(`^${key}=.*$`, "m").test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, "m"), () => line)
    : `${env.trimEnd()}\n${line}\n`;
}
writeFileSync(envPath, env, { mode: 0o600 });
console.log(`✓ wrote ${found.size} token(s) to .env: ${[...found.keys()].join(", ")}`);
const missing = Object.keys(ERA_CONNECTORS).filter((k) => !found.has(k as EraConnector));
if (missing.length) console.log(`  missing: ${missing.join(", ")}`);

if (args.has("--register")) {
  for (const [svc, { name, url, token }] of found) {
    spawnSync("claude", ["mcp", "remove", name, "--scope", "user"], { stdio: "ignore" });
    const r = spawnSync(
      "claude",
      ["mcp", "add", name, "--scope", "user", "--transport", "http", url, "--header", `Authorization: Bearer ${token}`],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    console.log(r.status === 0 ? `✓ Claude MCP server added: ${svc}` : `✗ ${svc}: ${r.stderr.trim()}`);
  }
  console.log("Restart Claude Code / start a new session to load the Era MCP servers.");
}
