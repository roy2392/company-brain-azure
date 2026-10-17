export const SOURCES = ["salesforce", "zendesk", "gong", "slack", "jira", "confluence", "drive"] as const;
export type Source = (typeof SOURCES)[number];

/** A normalized, citable unit of company knowledge (one ticket, call, thread, page, opportunity…). */
export interface BrainDoc {
  _id: string; // `${source}:${kind}:${sourceId}`
  source: Source;
  kind: string;
  sourceId: string;
  title: string;
  text: string;
  url?: string;
  ts: Date;
  accountIds: string[]; // entity ids, e.g. account:acacia-partners
  personIds: string[]; // entity ids, e.g. person:jane.doe@wisteria.com
  meta: Record<string, unknown>;
}

export interface Chunk {
  _id: string; // `${docId}#${n}`
  docId: string;
  source: Source;
  kind: string;
  title: string;
  text: string;
  url?: string;
  ts: Date;
  accountIds: string[];
  personIds: string[];
  embedding?: number[];
}

export type EntityType = "account" | "person" | "product" | "team";

export interface EntityLink {
  to: string;
  rel: string; // owns | contact_of | works_on | uses | member_of …
  source: Source;
}

export interface Entity {
  _id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  attrs: Record<string, unknown>;
  links: EntityLink[];
  sources: Source[];
}

/** What a connector hands to the indexer. */
export interface RawBatch {
  collection: string; // raw_<source>_<object>
  source: Source;
  object: string; // vendor object name, e.g. Opportunity, tickets, conversations.history
  description: string;
  docs: Array<Record<string, unknown> & { _id: string }>;
}

export interface ConnectorOutput {
  raw: RawBatch[];
  docs: BrainDoc[];
  entities: Entity[];
}

export interface Citation {
  id: string; // BrainDoc _id, or om:<type>:<fqn> for catalog assets
  source: Source | "openmetadata" | "memory";
  kind: string;
  title: string;
  url?: string;
  ts: string;
  snippet?: string;
}
