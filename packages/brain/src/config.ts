import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/** Repo root = the directory holding docker-compose.yml (walk up from this file). */
function findRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "docker-compose.yml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export const ROOT = findRoot();
loadEnv({ path: path.join(ROOT, ".env"), quiet: true });

const env = (k: string, d = "") => process.env[k]?.trim() || d;

export const ERA_CONNECTORS = {
  salesforce: "ERA_SALESFORCE_TOKEN",
  zendesk: "ERA_ZENDESK_TOKEN",
  gong: "ERA_GONG_TOKEN",
  slack: "ERA_SLACK_TOKEN",
  "jira-confluence": "ERA_JIRA_CONFLUENCE_TOKEN",
  "google-drive": "ERA_GOOGLE_DRIVE_TOKEN",
} as const;
export type EraConnector = keyof typeof ERA_CONNECTORS;

export const cfg = {
  root: ROOT,
  cacheDir: path.join(ROOT, ".cache"),
  era: {
    envId: env("ERA_ENV_ID"),
    token: (c: EraConnector) => env(ERA_CONNECTORS[c]),
    baseUrl: (c: EraConnector) => `https://${c}-mcp.era.eon.io`,
  },
  mongo: {
    uri: env("MONGODB_URI", "mongodb://localhost:27017/?directConnection=true"),
    db: env("MONGODB_DB", "wisteria_brain"),
  },
  embed: {
    provider: env("EMBEDDINGS_PROVIDER", "ollama") as "ollama" | "voyage" | "none",
    ollamaUrl: env("OLLAMA_URL", "http://localhost:11434"),
    ollamaModel: env("OLLAMA_EMBED_MODEL", "nomic-embed-text"),
    voyageKey: env("VOYAGE_API_KEY"),
    voyageModel: env("VOYAGE_EMBED_MODEL", "voyage-3.5"),
  },
  om: {
    url: env("OPENMETADATA_URL", "http://localhost:8585"),
    adminEmail: env("OPENMETADATA_ADMIN_EMAIL", "admin@open-metadata.org"),
    adminPassword: env("OPENMETADATA_ADMIN_PASSWORD", "admin"),
    /** JWT of the read-only company-brain-bot, for OpenMetadata's MCP server (npm run om:mcp) */
    mcpToken: env("OPENMETADATA_MCP_TOKEN"),
  },
  agent: {
    model: env("BRAIN_MODEL", "claude-sonnet-5-5"),
  },
  /** agent-memory (github.com/mongodb-partners/agent-memory): the Wisteria agents' shared memory, in the same Atlas */
  memory: {
    url: env("AGENT_MEMORY_URL", "http://localhost:8000"),
    db: env("AGENT_MEMORY_DB", "agent_memory"),
    /** one memory space every Wisteria agent reads and writes */
    team: env("AGENT_MEMORY_TEAM", "wisteria-revenue-team"),
    llmModel: env("AGENT_MEMORY_LLM_MODEL", "qwen2.5:3b"),
  },
  /** Foundry agents reach the brain only through this gateway, exposed with a Microsoft Dev Tunnel */
  gateway: {
    port: Number(env("FOUNDRY_GATEWAY_PORT", "8790")),
    /** 0.0.0.0 inside the VM's container network (Caddy terminates TLS in front) */
    host: env("FOUNDRY_GATEWAY_HOST", "127.0.0.1"),
    /** per-agent keys are HMACs of this secret (npm run foundry:agents creates it) */
    secret: env("FOUNDRY_GATEWAY_SECRET"),
    /** the tunnel's public https URL */
    publicUrl: env("FOUNDRY_GATEWAY_URL"),
  },
  /** the Microsoft Foundry project that hosts the Wisteria agents */
  foundry: {
    endpoint: env("FOUNDRY_PROJECT_ENDPOINT"),
    model: env("FOUNDRY_AGENT_MODEL", "gpt-5.4"),
    /** on the Azure VM: tokens from the managed identity instead of az login */
    useManagedIdentity: env("FOUNDRY_USE_MANAGED_IDENTITY") === "1",
    subscription: env("FOUNDRY_SUBSCRIPTION_ID"),
    resourceGroup: env("FOUNDRY_RESOURCE_GROUP"),
    account: env("FOUNDRY_ACCOUNT"),
    project: env("FOUNDRY_PROJECT"),
  },
  focusAccounts: Number(env("BRAIN_FOCUS_ACCOUNTS", "40")),
};
