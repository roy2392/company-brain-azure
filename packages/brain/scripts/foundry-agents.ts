/**
 * Create (or update) the Wisteria role agents in Microsoft Foundry, wired to the brain through the gateway.
 *   npm run foundry:agents                   # connections + agents (laptop, az login)
 *   npm run foundry:agents -- --agents-only  # agents only (Azure VM: Terraform owns the connections, managed identity)
 *   npm run foundry:agents -- --delete       # remove the agents (and, without --agents-only, their connections)
 * Needs FOUNDRY_* and FOUNDRY_GATEWAY_URL in .env, and OpenMetadata running.
 * Each agent gets two MCP tools behind project connections that hold its gateway key (never the agent definition):
 *   wisteria_brain → <gateway>/agents/<agent>/mcp                 brain tools + shared memory
 *   openmetadata   → <gateway>/agents/<agent>/openmetadata/mcp    OpenMetadata read tools, as the agent's own bot
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { AGENTS, type WisteriaAgent } from "../src/agents/roster.ts";
import { brainNow, closeDb } from "../src/brain/store.ts";
import { cfg } from "../src/config.ts";
import { azureToken, deleteAgent, foundryAgentName, upsertAgent } from "../src/foundry/client.ts";
import { agentKey } from "../src/foundry/keys.ts";
import { agentToken } from "../src/om/agents.ts";
import { OM } from "../src/om/client.ts";
import { OM_MCP_READ_TOOLS } from "../src/om/mcp.ts";

const f = cfg.foundry;
const agentsOnly = process.argv.includes("--agents-only");
const missing = Object.entries({ FOUNDRY_PROJECT_ENDPOINT: f.endpoint, FOUNDRY_GATEWAY_URL: cfg.gateway.publicUrl, ...(agentsOnly ? {} : { FOUNDRY_SUBSCRIPTION_ID: f.subscription, FOUNDRY_RESOURCE_GROUP: f.resourceGroup, FOUNDRY_ACCOUNT: f.account, FOUNDRY_PROJECT: f.project }) })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length) throw new Error(`set ${missing.join(", ")} in .env`);

// the gateway secret (laptop mode): created once, stored only in .env (mode 600)
if (!agentsOnly && !cfg.gateway.secret && !process.env.FOUNDRY_AGENT_KEYS) {
  cfg.gateway.secret = randomBytes(32).toString("base64url");
  const file = path.join(cfg.root, ".env");
  appendFileSync(file, `\n# Foundry gateway: per-agent MCP keys are HMACs of this secret\nFOUNDRY_GATEWAY_SECRET=${cfg.gateway.secret}\n`);
  chmodSync(file, 0o600);
  console.log("created FOUNDRY_GATEWAY_SECRET in .env (restart npm run gateway to pick it up)");
}

const arm = agentsOnly ? "" : await azureToken("https://management.azure.com/");
const connectionsUrl = `https://management.azure.com/subscriptions/${f.subscription}/resourceGroups/${f.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${f.account}/projects/${f.project}/connections`;
const slug = (a: WisteriaAgent) => a.name.replace(/_/g, "-");

async function call(method: string, url: string, token: string, body?: unknown) {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok && !(method === "DELETE" && r.status === 404)) throw new Error(`${method} ${url.replace(/\?.*/, "")} → ${r.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function connection(name: string, target: string, authorization: string) {
  await call("PUT", `${connectionsUrl}/${name}?api-version=2025-04-01-preview`, arm, {
    properties: { authType: "CustomKeys", category: "RemoteTool", group: "GenericProtocol", target, isSharedToAll: true, credentials: { keys: { Authorization: authorization } }, metadata: {} },
  });
}

async function instructions(a: WisteriaAgent) {
  const today = (await brainNow()).toISOString().slice(0, 10);
  const others = AGENTS.filter((x) => x.name !== a.name).map((x) => x.displayName).join(", ");
  return `${a.role}

You are the ${a.displayName} at Wisteria Group, a B2B fintech (~20,000 employees, ~6,000 customers). The company brain's "today" is ${today}.

Your tools:
- wisteria_brain: Wisteria's company brain on MongoDB Atlas (Salesforce, Zendesk, Gong, Slack, Jira, Confluence, Google Drive): ${a.tools.join(", ")}.
- Team memory, on the same server: recall_team_memory, remember, team_activity. You share it with the ${others} (agent-memory on MongoDB Atlas).
- openmetadata: Wisteria's governed catalog (definitions, owners, lineage), read-only.

How to work:
1. Start every new topic with recall_team_memory. When a teammate already established something, use it, say which teammate it came from, cite it as [[memory:<id>]] and do not re-investigate it.
2. Use the brain only for the gaps. Ground every statement in tool results and cite records inline exactly as the tools return them, e.g. [[zendesk:ticket:123]]. Never make up an id or a number.
3. For business terms and metrics (ARR, churn, health), use the governed definition and owner from the catalog.
4. When you learn something new and durable, save it with remember: one self-contained fact per call (account, dates, amounts, source ids inline), the question it answers, a topic and the account. At most 3 per answer.
5. This is a live conversation: answer in at most 150 words, lead with the answer, then a few cited bullets.`;
}

const om = await new OM().login();
for (const a of AGENTS) {
  const brainConn = `wisteria-brain-${slug(a)}`;
  const omConn = `wisteria-om-${slug(a)}`;
  const brainUrl = `${cfg.gateway.publicUrl}/agents/${a.name}/mcp`;
  const omUrl = `${cfg.gateway.publicUrl}/agents/${a.name}/openmetadata/mcp`;
  if (process.argv.includes("--delete")) {
    await deleteAgent(foundryAgentName(a));
    if (!agentsOnly) for (const c of [brainConn, omConn]) await call("DELETE", `${connectionsUrl}/${c}?api-version=2025-04-01-preview`, arm);
    console.log(`✗ removed ${foundryAgentName(a)}${agentsOnly ? "" : " and its connections"}`);
    continue;
  }
  if (!agentsOnly) {
    await connection(brainConn, brainUrl, `Bearer ${agentKey(a.name)}`);
    await connection(omConn, omUrl, `Bearer ${agentKey(a.name)}`);
  }
  await agentToken(om, a); // the agent's OpenMetadata bot, used by the gateway
  const v = await upsertAgent(foundryAgentName(a), {
    definition: {
      kind: "prompt",
      model: f.model,
      instructions: await instructions(a),
      tools: [
        { type: "mcp", server_label: "wisteria_brain", server_url: brainUrl, require_approval: "never", project_connection_id: brainConn },
        { type: "mcp", server_label: "openmetadata", server_url: omUrl, require_approval: "never", allowed_tools: OM_MCP_READ_TOOLS, project_connection_id: omConn },
      ],
    },
    description: `${a.displayName} (${a.team}). Shares one memory with the other Wisteria agents through agent-memory on MongoDB Atlas; governed in OpenMetadata.`,
    metadata: { team: a.team, showcase: "wisteria-company-brain" },
  });
  console.log(`✓ ${foundryAgentName(a)} v${v?.version ?? "?"} · ${f.model} · tools: wisteria_brain (${a.tools.length} brain + 3 memory), openmetadata (${OM_MCP_READ_TOOLS.length} read tools)`);
}
if (!process.argv.includes("--delete")) console.log(`\nOpen the Foundry portal → project ${f.project} → Agents, pick a wisteria-* agent and chat in the playground. Keep npm run gateway and the dev tunnel running.`);
await closeDb();
