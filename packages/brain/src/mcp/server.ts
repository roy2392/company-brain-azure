/**
 * Company Brain as an MCP server (stdio). Add to Claude Code:
 *   claude mcp add wisteria-brain -- npx tsx <repo>/packages/brain/src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BRAIN_TOOLS } from "../brain/tools.ts";

const server = new McpServer(
  { name: "wisteria-company-brain", version: "0.1.0" },
  {
    instructions:
      "Wisteria Group's company brain (MongoDB Atlas + OpenMetadata). Start with account_360 for a company, search_brain for evidence, explain_data for any metric or business term, what_changed for 'this quarter' questions. Cite records with the [[id]] markers the tools return.",
  },
);

for (const t of BRAIN_TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, async (args: any) => {
    try {
      const r = await t.run(args);
      return { content: [{ type: "text" as const, text: r.text }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error in ${t.name}: ${String(e)}` }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
