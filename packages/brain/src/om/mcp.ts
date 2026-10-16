import { cfg } from "../config.ts";
import { OMError, type OM } from "./client.ts";

/** OpenMetadata's built-in MCP server and the read-only bot identity the brain uses with it. */

export const OM_MCP_URL = `${cfg.om.url}/mcp`;
export const BRAIN_BOT = "company-brain-bot";

/** Tools the brain agent may call (read-only), and the ones it must never call. */
export const OM_MCP_READ_TOOLS = ["search_metadata", "semantic_search", "get_entity_details", "get_entity_lineage", "find_context", "company_context", "get_user_context"];
export const OM_MCP_WRITE_TOOLS = ["create_entity", "patch_entity", "create_lineage", "create_test_case", "root_cause_analysis", "get_test_definitions", "describe_entity_type", "get_persona_context"];

/** Create (once) a bot user with the DataConsumer role and return its non-expiring JWT. */
export async function ensureBrainBotToken(om: OM): Promise<string> {
  let user = await om.byName<any>("users", BRAIN_BOT);
  if (!user) {
    const roles = await om.get<any>("/roles?limit=100");
    const consumer = roles.data.find((r: any) => r.name === "DataConsumer");
    user = await om.put("/users", {
      name: BRAIN_BOT,
      email: `${BRAIN_BOT}@wisteria.example`,
      displayName: "Company Brain agent",
      description: "Read-only identity the Company Brain agent uses with OpenMetadata's MCP server.",
      isBot: true,
      botName: BRAIN_BOT,
      roles: consumer ? [consumer.id] : [],
      authenticationMechanism: { authType: "JWT", config: { JWTTokenExpiry: "Unlimited" } },
    });
  }
  try {
    await om.put("/bots", { name: BRAIN_BOT, displayName: "Company Brain agent", botUser: BRAIN_BOT, description: "Read-only bot for the Company Brain agent (OpenMetadata MCP)." });
  } catch (e) {
    if (!(e instanceof OMError && [400, 409].includes(e.status))) throw e;
  }
  const auth = await om.get<any>(`/users/auth-mechanism/${user.id}`);
  if (!auth?.config?.JWTToken) throw new Error(`${BRAIN_BOT} has no JWT — check the bot in OpenMetadata settings`);
  return auth.config.JWTToken;
}
