export type Source = "salesforce" | "zendesk" | "gong" | "slack" | "jira" | "confluence" | "drive" | "openmetadata" | "memory";

export interface Citation {
  id: string;
  source: Source;
  kind: string;
  title: string;
  url?: string;
  ts: string;
  snippet?: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; citations: Citation[]; data?: any; error?: string }
  | { type: "done"; sessionId?: string; durationMs: number; costUsd?: number }
  | { type: "error"; message: string };

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  done: boolean;
  error?: string;
}

export interface Turn {
  id: string;
  question: string;
  text: string;
  tools: ToolCall[];
  citations: Citation[]; // in order of retrieval, unique by id
  account?: any; // account_360 data
  changed?: any; // what_changed data
  related?: any; // related_entities data
  status: "thinking" | "done" | "error";
  error?: string;
  durationMs?: number;
}

export interface Status {
  atlas: { uri: string; db: string; cloud: boolean };
  docs: Record<string, number>;
  chunks: number;
  entities: Record<string, number>;
  now: string;
  embeddings: string | null;
  model: string;
  om: { ok: boolean; url: string; version?: string; tables?: number; glossaryTerms?: number };
}
