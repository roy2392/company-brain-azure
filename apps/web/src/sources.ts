import type { Source } from "./types.ts";

export const SOURCE_META: Record<Source, { label: string; short: string; color: string }> = {
  salesforce: { label: "Salesforce", short: "Salesforce", color: "#1F6FA8" },
  zendesk: { label: "Zendesk", short: "Zendesk", color: "#1E7A68" },
  gong: { label: "Gong", short: "Gong", color: "#B0446E" },
  slack: { label: "Slack", short: "Slack", color: "#B9802A" },
  jira: { label: "Jira", short: "Jira", color: "#3B4FB8" },
  confluence: { label: "Confluence", short: "Confluence", color: "#4F86AE" },
  drive: { label: "Google Drive", short: "Drive", color: "#6C8A2E" },
  openmetadata: { label: "OpenMetadata", short: "Catalog", color: "#3F6B47" },
};

export const VINE_ORDER: Source[] = ["salesforce", "zendesk", "gong", "slack", "jira", "confluence", "drive", "openmetadata"];

/** Which systems a tool call reaches into — drives the vine while the agent is working. */
export function toolReach(name: string, input: Record<string, unknown>): Source[] {
  if (name.startsWith("openmetadata:")) return ["openmetadata"];
  const all: Source[] = ["salesforce", "zendesk", "gong", "slack", "jira", "confluence", "drive"];
  switch (name) {
    case "search_brain":
      return Array.isArray(input.sources) && input.sources.length ? (input.sources as Source[]) : all;
    case "account_360":
    case "what_changed":
      return all;
    case "explain_data":
      return ["openmetadata"];
    case "related_entities":
      return ["salesforce", "slack"];
    default:
      return [];
  }
}

export const sourceOfId = (id: string): Source => (id.startsWith("om:") ? "openmetadata" : (id.split(":")[0] as Source));

export const TOOL_VERB: Record<string, string> = {
  search_brain: "Searching",
  account_360: "Building the account view",
  related_entities: "Walking the company graph",
  what_changed: "Comparing this quarter with the last",
  explain_data: "Checking the catalog",
  get_record: "Opening a record",
};
