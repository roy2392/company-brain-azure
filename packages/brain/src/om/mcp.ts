import { cfg } from "../config.ts";
import { OMError, type OM } from "./client.ts";

/** OpenMetadata's built-in MCP server and the read-only bot identity the brain uses with it. */

export const OM_MCP_URL = `${cfg.om.url}/mcp`;
export const BRAIN_BOT = "company-brain-bot";

/** Tools the brain agent may call (read-only), and the ones it must never call. */
export const OM_MCP_READ_TOOLS = ["search_metadata", "semantic_search", "get_entity_details", "get_entity_lineage", "find_context", "company_context", "get_user_context"];
/** What the Foundry agents get through the gateway: read tools that work without OpenMetadata's vector search
 *  (semantic_search, find_context and company_context fail unless embeddings are configured in OpenMetadata). */
export const OM_MCP_AGENT_TOOLS = ["search_metadata", "get_entity_details", "get_entity_lineage"];
export const OM_MCP_WRITE_TOOLS = ["create_entity", "patch_entity", "create_lineage", "create_test_case", "root_cause_analysis", "get_test_definitions", "describe_entity_type", "get_persona_context"];

/** Create (once) a bot user with the given roles and return its non-expiring JWT. */
export async function ensureBotToken(om: OM, bot: { name: string; displayName: string; description: string; roles: string[] }): Promise<string> {
  let user = await om.byName<any>("users", bot.name);
  if (!user) {
    const roles = await om.get<any>("/roles?limit=100");
    user = await om.put("/users", {
      name: bot.name,
      email: `${bot.name}@wisteria.example`,
      displayName: bot.displayName,
      description: bot.description,
      isBot: true,
      botName: bot.name,
      roles: roles.data.filter((r: any) => bot.roles.includes(r.name)).map((r: any) => r.id),
      authenticationMechanism: { authType: "JWT", config: { JWTTokenExpiry: "Unlimited" } },
    });
  }
  try {
    await om.put("/bots", { name: bot.name, displayName: bot.displayName, botUser: bot.name, description: bot.description });
  } catch (e) {
    if (!(e instanceof OMError && [400, 409].includes(e.status))) throw e;
  }
  const auth = await om.get<any>(`/users/auth-mechanism/${user.id}`);
  if (!auth?.config?.JWTToken) throw new Error(`${bot.name} has no JWT — check the bot in OpenMetadata settings`);
  return auth.config.JWTToken;
}

/** The read-only identity the Company Brain agent uses with OpenMetadata's MCP server. */
export function ensureBrainBotToken(om: OM): Promise<string> {
  return ensureBotToken(om, {
    name: BRAIN_BOT,
    displayName: "Company Brain agent",
    description: "Read-only identity the Company Brain agent uses with OpenMetadata's MCP server.",
    roles: ["DataConsumer"],
  });
}
