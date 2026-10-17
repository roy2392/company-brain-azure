/**
 * The Wisteria ontology: business concepts (an is-a hierarchy), typed relations between them
 * (OWL-style object properties registered as OpenMetadata glossary relation types), mappings to
 * public vocabularies (schema.org, FIBO, W3C ORG, FOAF), and governed metrics.
 */

export const GLOSSARY = "WisteriaGlossary";
export const NS = "http://example.org/wisteria#";

export type Domain = "Sales" | "CustomerSuccess" | "Support" | "Engineering" | "Collaboration" | "CompanyBrain";
export type Team = "Sales" | "CustomerSuccess" | "Support" | "Engineering" | "Product" | "Finance" | "DataPlatform";
type Mapping = [iri: string, type: "EXACT_MATCH" | "CLOSE_MATCH" | "BROAD_MATCH" | "NARROW_MATCH" | "RELATED_MATCH"];

export interface Concept {
  name: string;
  displayName: string;
  parent?: string;
  kind: "class" | "role" | "metric" | "signal";
  description: string;
  synonyms?: string[];
  team: Team;
  domain: Domain;
  mappings?: Mapping[];
}

const SCHEMA = "https://schema.org/";
const FIBO = "https://spec.edmcouncil.org/fibo/ontology/";
const ORG = "http://www.w3.org/ns/org#";
const FOAF = "http://xmlns.com/foaf/0.1/";

// order matters: parents before children
export const CONCEPTS: Concept[] = [
  // parties
  { name: "Organization", displayName: "Organization", kind: "class", team: "Sales", domain: "Sales", description: "Any company Wisteria has a relationship with. Salesforce Accounts, Zendesk organizations and customer Slack channels all resolve to one Organization entity in the brain.", synonyms: ["company", "account"], mappings: [[`${SCHEMA}Organization`, "EXACT_MATCH"], [`${FIBO}BE/LegalEntities/LegalPersons/LegalEntity`, "CLOSE_MATCH"]] },
  { name: "Customer", displayName: "Customer", parent: "Organization", kind: "class", team: "Sales", domain: "Sales", description: "An Organization with at least one active contract (`Account.Type = 'Customer'`). The unit the brain answers about.", synonyms: ["client"], mappings: [[`${FIBO}FND/ProductsAndServices/ProductsAndServices/Customer`, "CLOSE_MATCH"]] },
  { name: "Prospect", displayName: "Prospect", parent: "Organization", kind: "class", team: "Sales", domain: "Sales", description: "An Organization without an active contract (`Account.Type = 'Prospect'`)." },
  { name: "Person", displayName: "Person", kind: "class", team: "DataPlatform", domain: "Collaboration", description: "A human being known to any Wisteria system, resolved by email across Salesforce, Slack, Zendesk, Gong and Jira.", mappings: [[`${SCHEMA}Person`, "EXACT_MATCH"], [`${FOAF}Person`, "EXACT_MATCH"]] },
  { name: "Employee", displayName: "Employee", parent: "Person", kind: "class", team: "DataPlatform", domain: "Collaboration", description: "A Wisteria employee (Slack member, Salesforce user). Titles come from Slack profiles — Wisteria's org chart.", mappings: [[`${FIBO}FND/Organizations/FormalOrganizations/Employee`, "CLOSE_MATCH"]] },
  { name: "AccountOwner", displayName: "Account Owner", parent: "Employee", kind: "role", team: "Sales", domain: "Sales", description: "The Employee accountable for a customer relationship (`Account.OwnerId`)." },
  { name: "Contact", displayName: "Contact", parent: "Person", kind: "class", team: "Sales", domain: "Sales", description: "A person working at a customer or prospect (Salesforce Contact, Zendesk requester, external Gong participant).", mappings: [[`${SCHEMA}Person`, "NARROW_MATCH"]] },
  { name: "Team", displayName: "Team", kind: "class", team: "DataPlatform", domain: "Collaboration", description: "A unit of Wisteria's organization (Sales, Support, Engineering…).", mappings: [[`${ORG}OrganizationalUnit`, "EXACT_MATCH"]] },
  // commercial
  { name: "Product", displayName: "Product", kind: "class", team: "Product", domain: "Sales", description: "Something Wisteria sells (Salesforce Product2).", mappings: [[`${SCHEMA}Product`, "EXACT_MATCH"], [`${FIBO}FND/ProductsAndServices/ProductsAndServices/Product`, "CLOSE_MATCH"]] },
  { name: "Opportunity", displayName: "Opportunity", kind: "class", team: "Sales", domain: "Sales", description: "A potential deal with stage, amount and close date.", synonyms: ["deal"], mappings: [[`${SCHEMA}Offer`, "RELATED_MATCH"]] },
  { name: "Renewal", displayName: "Renewal", parent: "Opportunity", kind: "class", team: "CustomerSuccess", domain: "CustomerSuccess", description: "An Opportunity to renew an expiring Contract (type Renewal; timed by `Contract.EndDate`)." },
  { name: "Expansion", displayName: "Expansion", parent: "Opportunity", kind: "class", team: "Sales", domain: "Sales", description: "An Opportunity to sell more to an existing Customer (upsell/cross-sell)." },
  { name: "Contract", displayName: "Contract", kind: "class", team: "Finance", domain: "Sales", description: "A signed agreement with a Customer, with start and end dates.", mappings: [[`${FIBO}FND/Agreements/Contracts/Contract`, "EXACT_MATCH"]] },
  // service
  { name: "SupportTicket", displayName: "Support Ticket", kind: "class", team: "Support", domain: "Support", description: "A customer request in Zendesk or a Salesforce Case.", synonyms: ["ticket", "case"] },
  { name: "Escalation", displayName: "Escalation", parent: "SupportTicket", kind: "signal", team: "Support", domain: "Support", description: "A Support Ticket with urgent/high priority, flagged escalated, or pushed to engineering as a Jira issue." },
  // interactions
  { name: "Interaction", displayName: "Interaction", kind: "class", team: "CustomerSuccess", domain: "CustomerSuccess", description: "Any recorded exchange with or about a customer: calls, meetings, threads, logged activities.", mappings: [[`${SCHEMA}Event`, "BROAD_MATCH"]] },
  { name: "CustomerCall", displayName: "Customer Call", parent: "Interaction", kind: "class", team: "CustomerSuccess", domain: "CustomerSuccess", description: "A recorded external meeting in Gong with participants, AI summary and transcript.", synonyms: ["call", "meeting"] },
  { name: "QBR", displayName: "Quarterly Business Review (QBR)", parent: "CustomerCall", kind: "class", team: "CustomerSuccess", domain: "CustomerSuccess", description: "Quarterly executive review with a customer: the call in Gong, the deck in Google Drive." },
  { name: "SlackConversation", displayName: "Slack Conversation", parent: "Interaction", kind: "class", team: "DataPlatform", domain: "Collaboration", description: "A Slack thread or a day of messages in a customer channel (#account, #account-bid, #account-launch).", mappings: [[`${SCHEMA}Conversation`, "EXACT_MATCH"]] },
  // engineering & knowledge
  { name: "Issue", displayName: "Issue", kind: "class", team: "Engineering", domain: "Engineering", description: "A Jira work item (bug, task, story)." },
  { name: "Incident", displayName: "Incident", parent: "Issue", kind: "class", team: "Engineering", domain: "Engineering", description: "A production-impacting Issue, typically highest priority." },
  { name: "Document", displayName: "Document", kind: "class", team: "Product", domain: "Collaboration", description: "Written knowledge: Confluence pages, Google Drive docs, decks and sheets.", mappings: [[`${SCHEMA}DigitalDocument`, "EXACT_MATCH"], [`${FOAF}Document`, "EXACT_MATCH"]] },
  // metrics & signals
  { name: "ARR", displayName: "Annual Recurring Revenue (ARR)", kind: "metric", team: "Finance", domain: "Sales", description: "Annualized contract value of a Customer (seats × price) as recorded on the customer account, matching the active Salesforce contract. Owned by Finance — the only approved revenue number for customer conversations. Not the same as closed-won bookings.", synonyms: ["annual recurring revenue", "recurring revenue"] },
  { name: "Pipeline", displayName: "Pipeline", kind: "metric", team: "Sales", domain: "Sales", description: "Sum of open opportunity amounts (not Closed Won / Closed Lost)." },
  { name: "HealthScore", displayName: "Customer Health Score", kind: "metric", team: "CustomerSuccess", domain: "CustomerSuccess", description: "Composite view of a Customer's health from support load, escalations, call sentiment, Slack activity and commercial momentum." },
  { name: "ChurnRisk", displayName: "Churn Risk", kind: "signal", team: "CustomerSuccess", domain: "CustomerSuccess", description: "Brain-derived signal that a Customer may churn — always explained with cited evidence (escalations, negative call moments, stalled renewal, executive silence).", synonyms: ["at risk", "risk"] },
  { name: "Churn", displayName: "Churn", kind: "metric", team: "Finance", domain: "CustomerSuccess", description: "Loss of a Customer or recurring revenue at or before renewal." },
];

/** Wisteria object properties, registered as glossary relation types (with inverses). */
export interface RelationType {
  name: string;
  displayName: string;
  description: string;
  inverse: string;
  inverseDisplayName: string;
  domain: string[];
  range: string[];
  predicate: string;
  inversePredicate: string;
  category: "associative" | "hierarchical";
  color: string;
}

export const RELATION_TYPES: RelationType[] = [
  { name: "worksFor", displayName: "Works For", inverse: "employs", inverseDisplayName: "Employs", description: "A person works for an organization.", domain: ["Person"], range: ["Organization"], predicate: `${SCHEMA}worksFor`, inversePredicate: `${NS}employs`, category: "associative", color: "#1F6FA8" },
  { name: "owns", displayName: "Owns", inverse: "ownedBy", inverseDisplayName: "Owned By", description: "An employee is accountable for a customer relationship.", domain: ["Employee"], range: ["Customer"], predicate: `${NS}owns`, inversePredicate: `${NS}ownedBy`, category: "associative", color: "#6E4FA3" },
  { name: "memberOf", displayName: "Member Of", inverse: "hasMember", inverseDisplayName: "Has Member", description: "An employee belongs to a team.", domain: ["Employee"], range: ["Team"], predicate: `${ORG}memberOf`, inversePredicate: `${ORG}hasMember`, category: "hierarchical", color: "#3F6B47" },
  { name: "hasContract", displayName: "Has Contract", inverse: "contractOf", inverseDisplayName: "Contract Of", description: "A customer is party to a contract.", domain: ["Customer"], range: ["Contract"], predicate: `${NS}hasContract`, inversePredicate: `${NS}contractOf`, category: "associative", color: "#8A5A00" },
  { name: "buys", displayName: "Buys", inverse: "boughtBy", inverseDisplayName: "Bought By", description: "A customer uses a product.", domain: ["Customer"], range: ["Product"], predicate: `${NS}buys`, inversePredicate: `${NS}boughtBy`, category: "associative", color: "#6C8A2E" },
  { name: "about", displayName: "About", inverse: "subjectOf", inverseDisplayName: "Subject Of", description: "A record or interaction concerns a customer or product.", domain: ["Interaction", "SupportTicket", "Document", "Issue", "Opportunity"], range: ["Organization", "Product", "Contract"], predicate: `${SCHEMA}about`, inversePredicate: `${SCHEMA}subjectOf`, category: "associative", color: "#4F86AE" },
  { name: "raisedBy", displayName: "Raised By", inverse: "raised", inverseDisplayName: "Raised", description: "A ticket was opened by a contact.", domain: ["SupportTicket"], range: ["Contact"], predicate: `${NS}raisedBy`, inversePredicate: `${NS}raised`, category: "associative", color: "#1E7A68" },
  { name: "escalatesTo", displayName: "Escalates To", inverse: "escalatedFrom", inverseDisplayName: "Escalated From", description: "A support escalation becomes engineering work.", domain: ["SupportTicket"], range: ["Issue"], predicate: `${NS}escalatesTo`, inversePredicate: `${NS}escalatedFrom`, category: "associative", color: "#A33A3A" },
  { name: "indicates", displayName: "Indicates", inverse: "indicatedBy", inverseDisplayName: "Indicated By", description: "Evidence that is a signal for a risk or outcome.", domain: ["Escalation", "CustomerCall", "Renewal", "SlackConversation"], range: ["ChurnRisk", "HealthScore"], predicate: `${NS}indicates`, inversePredicate: `${NS}indicatedBy`, category: "associative", color: "#B0446E" },
];

/** Ontology statements between concepts. relation is a RELATION_TYPES name or an OpenMetadata built-in. */
export const STATEMENTS: Array<[subject: string, relation: string, object: string]> = [
  ["Contact", "worksFor", "Customer"],
  ["Employee", "memberOf", "Team"],
  ["AccountOwner", "owns", "Customer"],
  ["Customer", "hasContract", "Contract"],
  ["Customer", "buys", "Product"],
  ["Opportunity", "about", "Organization"],
  ["Renewal", "about", "Contract"],
  ["SupportTicket", "raisedBy", "Contact"],
  ["SupportTicket", "about", "Product"],
  ["Escalation", "escalatesTo", "Issue"],
  ["CustomerCall", "about", "Customer"],
  ["SlackConversation", "about", "Customer"],
  ["Document", "about", "Customer"],
  ["Issue", "about", "Product"],
  ["Escalation", "indicates", "ChurnRisk"],
  ["CustomerCall", "indicates", "HealthScore"],
  ["Renewal", "indicates", "ChurnRisk"],
  ["SlackConversation", "indicates", "HealthScore"],
  ["ARR", "calculatedFrom", "Opportunity"],
  ["ARR", "calculatedFrom", "Contract"],
  ["Pipeline", "calculatedFrom", "Opportunity"],
  ["HealthScore", "calculatedFrom", "SupportTicket"],
  ["HealthScore", "calculatedFrom", "CustomerCall"],
  ["HealthScore", "calculatedFrom", "Opportunity"],
  ["ChurnRisk", "calculatedFrom", "HealthScore"],
  ["Churn", "calculatedFrom", "Contract"],
  ["Churn", "relatedTo", "ChurnRisk"],
  ["QBR", "seeAlso", "Document"],
];

/** Governed metrics (OpenMetadata Metric assets) with the expression the brain actually runs. */
export interface MetricDef {
  name: string;
  displayName: string;
  term: string;
  description: string;
  metricType: string;
  unit: string;
  granularity?: string;
  language: "JavaScript" | "SQL" | "External";
  code: string;
  from: string[]; // Atlas collections it is computed from
  team: Team;
  domain: Domain;
}

export const METRICS: MetricDef[] = [
  {
    name: "annual_recurring_revenue", displayName: "ARR", term: "ARR", metricType: "SUM", unit: "DOLLARS", granularity: "YEAR", team: "Finance", domain: "Sales", language: "JavaScript",
    description: "Annualized contract value per customer from the account record (Zendesk organization field arr, matching the Salesforce contract). Shown on every account card and used by the agent for revenue questions.",
    code: `db.raw_zendesk_organizations.aggregate([\n  { $project: { name: 1, arr: "$organization_fields.arr", renewal: "$organization_fields.renewal_date" } }\n])`,
    from: ["raw_zendesk_organizations", "raw_salesforce_contract"],
  },
  {
    name: "closed_won_12m", displayName: "Closed-won bookings (12 months)", term: "Opportunity", metricType: "SUM", unit: "DOLLARS", granularity: "YEAR", team: "Sales", domain: "Sales", language: "JavaScript",
    description: "Closed Won opportunity amounts over the trailing 12 months per customer. Bookings, not ARR: renewals, pilots and expansions all count.",
    code: `db.raw_salesforce_opportunity.aggregate([\n  { $match: { IsWon: true, CloseDate: { $gte: brainNowMinus(365) } } },\n  { $group: { _id: "$AccountId", bookings: { $sum: "$Amount" } } }\n])`,
    from: ["raw_salesforce_opportunity"],
  },
  {
    name: "open_pipeline", displayName: "Open Pipeline", term: "Pipeline", metricType: "SUM", unit: "DOLLARS", team: "Sales", domain: "Sales", language: "JavaScript",
    description: "Sum of open opportunity amounts per customer.",
    code: `db.docs.aggregate([\n  { $match: { kind: "opportunity", "meta.isClosed": false } },\n  { $unwind: "$accountIds" },\n  { $group: { _id: "$accountIds", pipeline: { $sum: "$meta.amount" } } }\n])`,
    from: ["docs", "raw_salesforce_opportunity"],
  },
  {
    name: "escalation_rate", displayName: "Escalation Rate", term: "Escalation", metricType: "RATIO", unit: "PERCENTAGE", granularity: "QUARTER", team: "Support", domain: "Support", language: "JavaScript",
    description: "Share of a customer's tickets and cases in the last 90 days that are urgent/high priority or escalated.",
    code: `db.docs.aggregate([\n  { $match: { kind: { $in: ["ticket", "case"] }, ts: { $gte: brainNowMinus(90) } } },\n  { $unwind: "$accountIds" },\n  { $group: { _id: "$accountIds", total: { $sum: 1 }, escalated: { $sum: { $cond: ["$meta.escalated", 1, 0] } } } },\n  { $set: { rate: { $divide: ["$escalated", "$total"] } } }\n])`,
    from: ["docs", "raw_zendesk_tickets", "raw_salesforce_case"],
  },
  {
    name: "customer_health_score", displayName: "Customer Health Score", term: "HealthScore", metricType: "DERIVED", unit: "OTHER", team: "CustomerSuccess", domain: "CustomerSuccess", language: "External",
    description: "Assessed by the company brain agent per customer from cited signals: escalation rate, Gong call moments, Slack activity, renewal timing and pipeline momentum. Not a stored number — every assessment comes with its evidence.",
    code: "Evaluated by the Company Brain agent (account_360 + search_brain) — see the AI application in OpenMetadata.",
    from: ["docs", "chunks", "entities"],
  },
];
