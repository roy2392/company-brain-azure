import type { Source } from "../brain/types.ts";

/**
 * Physical model of the brain, as OpenMetadata should know it before (and after) any data lands:
 * every Era object the connectors read, the Atlas collection it lands in, its columns, keys,
 * the ontology concept it instantiates, and how its columns flow into docs / entities.
 * Columns follow each vendor's public API; real samples refine them on `om:setup` after ingestion.
 */

export type ColType = "STRING" | "TEXT" | "BIGINT" | "DOUBLE" | "BOOLEAN" | "TIMESTAMP" | "DATE" | "JSON" | "ARRAY";

export interface ColSpec {
  name: string;
  type: ColType;
  description?: string;
  arrayOf?: "STRING" | "JSON" | "DOUBLE";
  /** ontology term (glossary term name) this column carries */
  term?: string;
  pii?: boolean;
}

export interface EraObject {
  source: Source;
  object: string; // table name in the Era source service
  collection: string; // Atlas raw collection
  description: string;
  concept: string; // ontology class the records are instances of
  key: string; // primary key column
  columns: ColSpec[];
  /** [column, referenced object, referenced column] — becomes an ER diagram in OpenMetadata */
  fks?: Array<[string, string, string]>;
  /** column lineage raw → docs (target docs column → source columns) */
  toDocs?: Record<string, string[]>;
  /** column lineage raw → entities */
  toEntities?: Record<string, string[]>;
  /** extra columns the connector adds in the Atlas raw collection */
  rawExtra?: ColSpec[];
  /** when the raw document keeps the API envelope (e.g. Jira `fields`), the raw collection's top-level columns */
  rawOnly?: string[];
}

const c = (name: string, type: ColType, description?: string, extra: Partial<ColSpec> = {}): ColSpec => ({ name, type, description, ...extra });
const id = (d = "Record id") => c("Id", "STRING", d);
const audit = [c("CreatedDate", "TIMESTAMP", "When the record was created"), c("LastModifiedDate", "TIMESTAMP", "Last change")];

export const ERA_OBJECTS: EraObject[] = [
  // ---------------- Salesforce ----------------
  {
    source: "salesforce", object: "Account", collection: "raw_salesforce_account", concept: "Organization", key: "Id",
    description: "Companies Wisteria sells to — customers and prospects. System of record for the Customer concept.",
    columns: [id("Account id"), c("Name", "STRING", "Company name — resolves to one brain entity"), c("Type", "STRING", "Customer | Prospect | Partner", { term: "Customer" }), c("Industry", "STRING"), c("BillingState", "STRING"), c("BillingCountry", "STRING"), c("Phone", "STRING", "Main phone", { pii: true }), c("Website", "STRING"), c("OwnerId", "STRING", "Account owner (User)", { term: "AccountOwner" }), c("AnnualRevenue", "DOUBLE", "Customer's own revenue (not Wisteria ARR)"), c("NumberOfEmployees", "BIGINT"), c("Description", "TEXT"), ...audit],
    fks: [["OwnerId", "User", "Id"]],
    toDocs: { sourceId: ["Id"], title: ["Name"], text: ["Name", "Type", "Industry", "BillingState", "Description"], ts: ["LastModifiedDate"], accountIds: ["Name"], meta: ["Type", "Industry", "OwnerId"] },
    toEntities: { _id: ["Name"], name: ["Name"], attrs: ["Type", "Industry", "BillingState", "BillingCountry", "Website", "NumberOfEmployees", "OwnerId"] },
  },
  {
    source: "salesforce", object: "Opportunity", collection: "raw_salesforce_opportunity", concept: "Opportunity", key: "Id",
    description: "Deals with stage, amount and close date. Feeds Pipeline and ARR.",
    columns: [id("Opportunity id"), c("Name", "STRING"), c("AccountId", "STRING", "Account the deal belongs to"), c("StageName", "STRING", "Sales stage", { term: "Pipeline" }), c("Amount", "DOUBLE", "Deal value (USD)", { term: "Pipeline" }), c("CloseDate", "DATE"), c("IsClosed", "BOOLEAN"), c("IsWon", "BOOLEAN"), c("Type", "STRING", "New Business | Renewal | Expansion", { term: "Renewal" }), c("Probability", "DOUBLE"), c("OwnerId", "STRING", "Opportunity owner (User)"), c("Description", "TEXT"), c("NextStep", "STRING"), ...audit],
    fks: [["AccountId", "Account", "Id"], ["OwnerId", "User", "Id"]],
    toDocs: { sourceId: ["Id"], title: ["Name"], text: ["Name", "StageName", "Amount", "CloseDate", "Type", "Probability", "NextStep", "Description"], ts: ["LastModifiedDate", "CloseDate"], accountIds: ["AccountId"], personIds: ["OwnerId"], meta: ["StageName", "Amount", "CloseDate", "IsClosed", "IsWon", "Type", "Probability"] },
  },
  {
    source: "salesforce", object: "Contract", collection: "raw_salesforce_contract", concept: "Contract", key: "Id",
    description: "Signed customer contracts with start and end dates — the basis of renewals and ARR.",
    columns: [id("Contract id"), c("ContractNumber", "STRING"), c("AccountId", "STRING"), c("Status", "STRING"), c("StartDate", "DATE"), c("EndDate", "DATE", "Contract end — drives renewal timing", { term: "Renewal" }), c("ContractTerm", "BIGINT", "Term in months"), c("Description", "TEXT"), c("OwnerId", "STRING"), ...audit],
    fks: [["AccountId", "Account", "Id"]],
    toDocs: { sourceId: ["Id"], title: ["ContractNumber"], text: ["ContractNumber", "Status", "StartDate", "EndDate", "ContractTerm", "Description"], ts: ["LastModifiedDate", "StartDate"], accountIds: ["AccountId"], meta: ["Status", "StartDate", "EndDate", "ContractTerm"] },
  },
  {
    source: "salesforce", object: "Case", collection: "raw_salesforce_case", concept: "SupportTicket", key: "Id",
    description: "Customer service cases (for focus accounts).",
    columns: [id("Case id"), c("CaseNumber", "STRING"), c("Subject", "STRING"), c("Description", "TEXT"), c("Status", "STRING"), c("Priority", "STRING", "High/critical priority marks an escalation", { term: "Escalation" }), c("Origin", "STRING"), c("Type", "STRING"), c("AccountId", "STRING"), c("ContactId", "STRING", "Who raised it"), c("OwnerId", "STRING"), c("IsEscalated", "BOOLEAN", "", { term: "Escalation" }), c("CreatedDate", "TIMESTAMP"), c("ClosedDate", "TIMESTAMP"), c("LastModifiedDate", "TIMESTAMP")],
    fks: [["AccountId", "Account", "Id"], ["ContactId", "Contact", "Id"]],
    toDocs: { sourceId: ["Id"], title: ["CaseNumber", "Subject"], text: ["Subject", "Status", "Priority", "Origin", "Description"], ts: ["LastModifiedDate", "CreatedDate"], accountIds: ["AccountId"], meta: ["Status", "Priority", "IsEscalated", "CreatedDate", "ClosedDate"] },
  },
  {
    source: "salesforce", object: "Contact", collection: "raw_salesforce_contact", concept: "Contact", key: "Id",
    description: "People at customer and prospect accounts.",
    columns: [id("Contact id"), c("Name", "STRING", "", { pii: true }), c("FirstName", "STRING", "", { pii: true }), c("LastName", "STRING", "", { pii: true }), c("Email", "STRING", "", { pii: true }), c("Title", "STRING"), c("AccountId", "STRING", "Company the person works for"), c("Department", "STRING"), c("Phone", "STRING", "", { pii: true })],
    fks: [["AccountId", "Account", "Id"]],
    toEntities: { _id: ["Email", "Name"], name: ["Name"], attrs: ["Title", "Email", "Department"], links: ["AccountId"] },
  },
  {
    source: "salesforce", object: "User", collection: "raw_salesforce_user", concept: "Employee", key: "Id",
    description: "Wisteria employees with CRM access — account and opportunity owners.",
    columns: [id("User id"), c("Name", "STRING", "", { pii: true }), c("Email", "STRING", "", { pii: true }), c("Title", "STRING"), c("Department", "STRING"), c("IsActive", "BOOLEAN"), c("ManagerId", "STRING", "Reports to (User)"), c("Alias", "STRING")],
    fks: [["ManagerId", "User", "Id"]],
    toEntities: { _id: ["Email", "Name"], name: ["Name"], attrs: ["Title", "Department", "Email", "IsActive"], links: ["Id"] },
  },
  {
    source: "salesforce", object: "Product2", collection: "raw_salesforce_product", concept: "Product", key: "Id",
    description: "Wisteria's product catalog.",
    columns: [id("Product id"), c("Name", "STRING"), c("Family", "STRING"), c("Description", "TEXT"), c("ProductCode", "STRING"), c("IsActive", "BOOLEAN")],
    toEntities: { _id: ["Name"], name: ["Name"], attrs: ["Family", "ProductCode", "Description"] },
  },
  {
    source: "salesforce", object: "Task", collection: "raw_salesforce_task", concept: "Interaction", key: "Id",
    description: "Sales activities (calls, emails, follow-ups) logged against focus accounts.",
    columns: [id("Task id"), c("Subject", "STRING"), c("Description", "TEXT"), c("Status", "STRING"), c("Priority", "STRING"), c("ActivityDate", "DATE"), c("WhatId", "STRING", "Related account"), c("WhoId", "STRING", "Related person"), c("OwnerId", "STRING"), c("CreatedDate", "TIMESTAMP")],
    fks: [["WhatId", "Account", "Id"], ["WhoId", "Contact", "Id"], ["OwnerId", "User", "Id"]],
    toDocs: { sourceId: ["Id"], title: ["Subject"], text: ["Subject", "Status", "ActivityDate", "Description"], ts: ["ActivityDate", "CreatedDate"], accountIds: ["WhatId"], personIds: ["OwnerId"], meta: ["Status", "Priority"] },
  },
  // ---------------- Zendesk ----------------
  {
    source: "zendesk", object: "organizations", collection: "raw_zendesk_organizations", concept: "Organization", key: "id",
    description: "Customer organizations in the help desk, matched to Salesforce accounts by name.",
    columns: [c("id", "BIGINT"), c("name", "STRING"), c("domain_names", "ARRAY", "", { arrayOf: "STRING" }), c("details", "TEXT"), c("notes", "TEXT"), c("tags", "ARRAY", "", { arrayOf: "STRING" }), c("organization_fields", "JSON", "Account record: ARR, seats, plan, renewal date, owner, status", { term: "ARR" }), c("created_at", "TIMESTAMP"), c("updated_at", "TIMESTAMP")],
    rawExtra: [c("account", "STRING", "Resolved brain account id")],
    toEntities: { _id: ["name"], aliases: ["name"], attrs: ["organization_fields", "domain_names"] },
  },
  {
    source: "zendesk", object: "tickets", collection: "raw_zendesk_tickets", concept: "SupportTicket", key: "id",
    description: "Support tickets for focus accounts with priority, status and (for escalations) the full comment thread.",
    columns: [c("id", "BIGINT"), c("subject", "STRING"), c("description", "TEXT"), c("status", "STRING"), c("priority", "STRING", "urgent/high = escalation", { term: "Escalation" }), c("type", "STRING"), c("requester_id", "BIGINT", "Who raised it"), c("assignee_id", "BIGINT"), c("organization_id", "BIGINT"), c("tags", "ARRAY", "", { arrayOf: "STRING" }), c("via", "JSON"), c("satisfaction_rating", "JSON"), c("created_at", "TIMESTAMP"), c("updated_at", "TIMESTAMP")],
    rawExtra: [c("account", "STRING", "Resolved brain account id"), c("comments", "ARRAY", "Comment thread", { arrayOf: "JSON" })],
    fks: [["organization_id", "organizations", "id"], ["requester_id", "users", "id"], ["assignee_id", "users", "id"]],
    toDocs: { sourceId: ["id"], title: ["id", "subject"], text: ["subject", "status", "priority", "type", "tags", "description", "comments"], ts: ["updated_at", "created_at"], accountIds: ["account"], personIds: ["requester_id"], meta: ["status", "priority", "type", "tags", "created_at"] },
  },
  {
    source: "zendesk", object: "users", collection: "raw_zendesk_users", concept: "Contact", key: "id",
    description: "Ticket requesters (customer contacts) and support agents.",
    columns: [c("id", "BIGINT"), c("name", "STRING", "", { pii: true }), c("email", "STRING", "", { pii: true }), c("phone", "STRING", "", { pii: true }), c("role", "STRING", "end-user | agent | admin"), c("organization_id", "BIGINT"), c("time_zone", "STRING"), c("created_at", "TIMESTAMP")],
    fks: [["organization_id", "organizations", "id"]],
    toEntities: { _id: ["email"], name: ["name"], attrs: ["email", "role"], links: ["organization_id"] },
  },
  // ---------------- Gong ----------------
  {
    source: "gong", object: "calls", collection: "raw_gong_calls", concept: "CustomerCall", key: "id",
    description: "Recorded external calls with participants, CRM context and AI summaries.",
    columns: [c("id", "STRING"), c("title", "STRING"), c("started", "TIMESTAMP"), c("duration", "BIGINT", "Seconds"), c("primaryUserId", "STRING", "Wisteria host"), c("direction", "STRING"), c("scope", "STRING", "External | Internal"), c("system", "STRING"), c("language", "STRING"), c("url", "STRING"), c("purpose", "STRING"), c("isPrivate", "BOOLEAN")],
    rawExtra: [c("extensive", "JSON", "Parties, CRM context, brief, key points, highlights")],
    toDocs: { sourceId: ["id"], title: ["title"], text: ["title", "started", "duration", "extensive"], url: ["url"], ts: ["started"], accountIds: ["title", "extensive"], personIds: ["extensive"], meta: ["duration", "direction"] },
    toEntities: { _id: ["extensive"], links: ["extensive"] },
  },
  {
    source: "gong", object: "transcripts", collection: "raw_gong_transcripts", concept: "CustomerCall", key: "callId",
    description: "Speaker-attributed transcripts for focus-account calls.",
    columns: [c("callId", "STRING"), c("transcript", "ARRAY", "Monologues: speakerId, topic, sentences", { arrayOf: "JSON" })],
    fks: [["callId", "calls", "id"]],
    toDocs: { text: ["transcript"], sourceId: ["callId"] },
  },
  // ---------------- Slack ----------------
  {
    source: "slack", object: "users", collection: "raw_slack_users", concept: "Employee", key: "id",
    description: "Workspace members with titles — Wisteria's org chart (CEO, VPs, teams).",
    columns: [c("id", "STRING"), c("name", "STRING"), c("real_name", "STRING", "", { pii: true }), c("deleted", "BOOLEAN"), c("is_bot", "BOOLEAN"), c("is_admin", "BOOLEAN"), c("tz", "STRING"), c("profile", "JSON", "title, email, phone", { pii: true })],
    toEntities: { _id: ["profile", "real_name"], name: ["real_name"], attrs: ["profile", "id"] },
  },
  {
    source: "slack", object: "conversations", collection: "raw_slack_channels", concept: "SlackConversation", key: "id",
    description: "Public channels — one per customer account (#account, #account-bid, #account-launch) plus company-wide ones.",
    columns: [c("id", "STRING"), c("name", "STRING", "Channel name; prefix resolves to the customer account"), c("created", "BIGINT"), c("creator", "STRING"), c("is_archived", "BOOLEAN"), c("is_general", "BOOLEAN"), c("num_members", "BIGINT"), c("topic", "JSON"), c("purpose", "JSON")],
    fks: [["creator", "users", "id"]],
    toEntities: { attrs: ["name"] },
  },
  {
    source: "slack", object: "messages", collection: "raw_slack_messages", concept: "SlackConversation", key: "ts",
    description: "Messages and thread replies from customer channels and #general.",
    columns: [c("ts", "STRING", "Message timestamp id"), c("user", "STRING"), c("text", "TEXT"), c("thread_ts", "STRING"), c("reply_count", "BIGINT"), c("reactions", "ARRAY", "", { arrayOf: "JSON" }), c("files", "ARRAY", "", { arrayOf: "JSON" }), c("subtype", "STRING")],
    rawExtra: [c("channel", "STRING", "Channel name"), c("channel_id", "STRING")],
    fks: [["user", "users", "id"]],
    toDocs: { sourceId: ["channel_id", "ts"], title: ["channel", "text"], text: ["user", "text"], ts: ["ts"], accountIds: ["channel", "text"], personIds: ["user"], meta: ["channel", "reply_count"] },
  },
  // ---------------- Jira / Confluence ----------------
  {
    source: "jira", object: "issues", collection: "raw_jira_issues", concept: "Issue", key: "key",
    description: "Jira issues updated in the ingestion window; customer mentions resolved from text.",
    columns: [c("id", "STRING"), c("key", "STRING"), c("summary", "STRING"), c("description", "TEXT", "Atlassian Document Format"), c("status", "STRING"), c("priority", "STRING", "Highest/critical = escalation path", { term: "Escalation" }), c("issuetype", "STRING"), c("project", "STRING"), c("labels", "ARRAY", "", { arrayOf: "STRING" }), c("assignee", "JSON", "", { pii: true }), c("reporter", "JSON", "", { pii: true }), c("created", "TIMESTAMP"), c("updated", "TIMESTAMP")],
    rawExtra: [c("fields", "JSON", "Issue fields as returned by the API (includes assignee/reporter)", { pii: true }), c("self", "STRING")],
    rawOnly: ["id", "key", "self", "fields"],
    toDocs: { sourceId: ["key"], title: ["key", "summary"], text: ["summary", "issuetype", "project", "status", "priority", "labels", "description"], ts: ["updated", "created"], accountIds: ["summary", "labels", "description"], personIds: ["assignee", "reporter"], meta: ["status", "priority", "issuetype", "project", "labels"] },
  },
  {
    source: "confluence", object: "pages", collection: "raw_confluence_pages", concept: "Document", key: "id",
    description: "Confluence pages — runbooks, specs, customer notes (storage format).",
    columns: [c("id", "STRING"), c("title", "STRING"), c("spaceId", "STRING"), c("status", "STRING"), c("parentId", "STRING"), c("authorId", "STRING"), c("createdAt", "TIMESTAMP"), c("version", "JSON"), c("body", "JSON", "storage-format HTML")],
    fks: [["parentId", "pages", "id"]],
    toDocs: { sourceId: ["id"], title: ["title"], text: ["title", "body"], ts: ["version", "createdAt"], accountIds: ["title", "body"] },
  },
  // ---------------- Google Drive ----------------
  {
    source: "drive", object: "files", collection: "raw_drive_files", concept: "Document", key: "id",
    description: "Drive files (QBR decks, docs, sheets); text read for files about focus accounts or changed recently.",
    columns: [c("id", "STRING"), c("name", "STRING"), c("mimeType", "STRING"), c("description", "TEXT"), c("owners", "ARRAY", "", { arrayOf: "JSON", pii: true }), c("webViewLink", "STRING"), c("size", "BIGINT"), c("createdTime", "TIMESTAMP"), c("modifiedTime", "TIMESTAMP")],
    rawExtra: [c("contentRead", "BOOLEAN", "Whether the file text was read into the brain")],
    toDocs: { sourceId: ["id"], title: ["name"], text: ["name", "description", "owners"], url: ["webViewLink"], ts: ["modifiedTime"], accountIds: ["name"], personIds: ["owners"], meta: ["mimeType"] },
  },
];

export const BRAIN_COLLECTIONS: Array<{ name: string; description: string; concepts: string[]; columns: ColSpec[] }> = [
  {
    name: "docs",
    description: "Normalized, citable documents — one per ticket, call, thread, page, opportunity… with resolved account and person ids. Every brain answer cites these ids.",
    concepts: ["Interaction", "Document", "SupportTicket", "Opportunity"],
    columns: [c("_id", "STRING", "<source>:<kind>:<sourceId> — the citation id"), c("source", "STRING", "salesforce | zendesk | gong | slack | jira | confluence | drive"), c("kind", "STRING"), c("sourceId", "STRING"), c("title", "STRING"), c("text", "TEXT"), c("url", "STRING"), c("ts", "TIMESTAMP", "Event time used for 'what changed' windows"), c("accountIds", "ARRAY", "Resolved customer entities", { arrayOf: "STRING", term: "Customer" }), c("personIds", "ARRAY", "Resolved people", { arrayOf: "STRING" }), c("meta", "JSON", "Typed facts: stage, amount, priority, status…")],
  },
  {
    name: "chunks",
    description: "Search-ready chunks of every doc with embeddings. Atlas Search index `chunks_text` + Vector Search index `chunks_vector`, fused with `$rankFusion`.",
    concepts: ["Document"],
    columns: [c("_id", "STRING", "<docId>#<n>"), c("docId", "STRING"), c("source", "STRING"), c("kind", "STRING"), c("title", "STRING"), c("text", "TEXT"), c("url", "STRING"), c("ts", "TIMESTAMP"), c("accountIds", "ARRAY", "", { arrayOf: "STRING", term: "Customer" }), c("personIds", "ARRAY", "", { arrayOf: "STRING" }), c("embedding", "ARRAY", "Vector (nomic-embed-text, 768d)", { arrayOf: "DOUBLE" })],
  },
  {
    name: "entities",
    description: "Entity graph: accounts, people and products resolved across all systems, with aliases and typed links. Traversed with `$graphLookup`.",
    concepts: ["Organization", "Person", "Product"],
    columns: [c("_id", "STRING", "account:<slug> | person:<email> | product:<slug>"), c("type", "STRING", "account | person | product"), c("name", "STRING"), c("aliases", "ARRAY", "", { arrayOf: "STRING" }), c("attrs", "JSON", "Merged attributes (industry, title, ARR, Slack channels…)"), c("links", "ARRAY", "Typed edges: owns, contact_of, works_on…", { arrayOf: "JSON" }), c("sources", "ARRAY", "Systems that mention the entity", { arrayOf: "STRING" })],
  },
];

/** docs → chunks column lineage */
export const DOCS_TO_CHUNKS: Record<string, string[]> = {
  docId: ["_id"], source: ["source"], kind: ["kind"], title: ["title"], text: ["text"], url: ["url"], ts: ["ts"], accountIds: ["accountIds"], personIds: ["personIds"], embedding: ["title", "text"],
};
