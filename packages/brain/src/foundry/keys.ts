import { createHmac, timingSafeEqual } from "node:crypto";
import { cfg } from "../config.ts";

/**
 * One key per agent: a key only opens its own agent's endpoints on the gateway.
 * On Azure, Terraform generates the keys and passes them as FOUNDRY_AGENT_KEYS (JSON {agent: key});
 * elsewhere they are HMACs of FOUNDRY_GATEWAY_SECRET.
 */
let explicit: Record<string, string> | null | undefined;

export function agentKey(agent: string): string {
  if (explicit === undefined) explicit = process.env.FOUNDRY_AGENT_KEYS ? (JSON.parse(process.env.FOUNDRY_AGENT_KEYS) as Record<string, string>) : null;
  if (explicit) {
    const k = explicit[agent];
    if (!k) throw new Error(`no gateway key for ${agent} in FOUNDRY_AGENT_KEYS`);
    return k;
  }
  if (!cfg.gateway.secret) throw new Error("set FOUNDRY_AGENT_KEYS or FOUNDRY_GATEWAY_SECRET");
  return createHmac("sha256", cfg.gateway.secret).update(`wisteria-agent:${agent}`).digest("base64url");
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
