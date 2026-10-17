import { execFileSync } from "node:child_process";
import { cfg } from "../config.ts";
import type { WisteriaAgent } from "../agents/roster.ts";

/**
 * Talking to Microsoft Foundry. On the Azure VM the token comes from the VM's managed identity (IMDS);
 * on a laptop from `az login`. Agents are prompt agents named wisteria-<role>.
 */
export const foundryAgentName = (a: WisteriaAgent) => `wisteria-${a.name.replace(/_/g, "-")}`;

const cache = new Map<string, { token: string; exp: number }>();

export async function azureToken(resource: string): Promise<string> {
  const hit = cache.get(resource);
  if (hit && hit.exp > Date.now() + 120_000) return hit.token;
  let token: string;
  let exp: number;
  if (cfg.foundry.useManagedIdentity) {
    const r = await fetch(`http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`, { headers: { Metadata: "true" } });
    if (!r.ok) throw new Error(`managed identity token for ${resource}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { access_token: string; expires_on: string };
    token = j.access_token;
    exp = Number(j.expires_on) * 1000;
  } else {
    const args = ["account", "get-access-token", "--resource", resource, "--query", "{t:accessToken,e:expires_on}", "-o", "json", ...(cfg.foundry.subscription ? ["--subscription", cfg.foundry.subscription] : [])];
    const j = JSON.parse(execFileSync("az", args, { encoding: "utf8" })) as { t: string; e: number };
    token = j.t;
    exp = j.e * 1000;
  }
  cache.set(resource, { token, exp });
  return token;
}

async function foundry<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${cfg.foundry.endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await azureToken("https://ai.azure.com")}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(300_000),
    });
    // token-rate limits: wait as told (or back off) and retry a few times
    if (r.status !== 429 || attempt >= 5) break;
    const wait = Math.min(60, Number(r.headers.get("retry-after")) || 5 * 2 ** attempt);
    await r.text();
    await new Promise((res) => setTimeout(res, wait * 1000));
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`Foundry ${method} ${path.replace(/\?.*/, "")} → ${r.status} ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}

export interface FoundryToolCall {
  server: string;
  name: string;
  arguments: unknown;
  output?: string;
  error?: string;
}

export interface FoundryTurn {
  conversationId: string;
  text: string;
  tools: FoundryToolCall[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One turn with a Foundry prompt agent (Conversations + Responses API, agent_reference). */
export async function chatWithAgent(a: WisteriaAgent, message: string, conversationId?: string): Promise<FoundryTurn> {
  const conv = conversationId ?? (await foundry<{ id: string }>("POST", "/openai/v1/conversations", {})).id;
  const r = await foundry<any>("POST", "/openai/v1/responses", {
    input: message,
    conversation: conv,
    agent_reference: { name: foundryAgentName(a), type: "agent_reference" },
  });
  const tools: FoundryToolCall[] = [];
  let text = "";
  for (const item of r.output ?? []) {
    if (item.type === "mcp_call") {
      let args: unknown = item.arguments;
      try {
        args = typeof item.arguments === "string" ? JSON.parse(item.arguments) : item.arguments;
      } catch {
        /* keep the raw string */
      }
      tools.push({ server: item.server_label, name: item.name, arguments: args, output: typeof item.output === "string" ? item.output.slice(0, 4000) : undefined, error: item.error ? String(typeof item.error === "string" ? item.error : JSON.stringify(item.error)) : undefined });
    } else if (item.type === "message") {
      for (const c of item.content ?? []) if (c.type === "output_text") text += c.text;
    }
  }
  return { conversationId: conv, text: text || r.output_text || "", tools, usage: r.usage };
}

/** Create or update a prompt agent (a new version each time). */
export async function upsertAgent(name: string, body: unknown) {
  return foundry<any>("POST", `/agents/${name}/versions?api-version=v1`, body);
}

export async function deleteAgent(name: string) {
  try {
    await foundry("DELETE", `/agents/${name}?api-version=v1`);
  } catch (e) {
    if (!/→ 404/.test(String(e))) throw e;
  }
}
