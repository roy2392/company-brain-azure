import type { Team } from "../om/ontology.ts";

/** Wisteria's role agents. They share one memory (agent-memory on Atlas) and are cataloged in OpenMetadata. */
export interface WisteriaAgent {
  name: string;
  displayName: string;
  team: Team;
  /** brain tools this agent may call (all read-only) */
  tools: string[];
  role: string;
  /** terminal color for npm run agents */
  color: number;
}

export const AGENTS: WisteriaAgent[] = [
  {
    name: "support_lead",
    displayName: "Support Lead agent",
    team: "Support",
    tools: ["account_360", "search_brain", "get_record"],
    role: "You run escalation triage for Wisteria's Support team. You find what is breaking for a customer, since when, and whether it is getting worse, from tickets, cases and the engineering issues behind them.",
    color: 36,
  },
  {
    name: "account_manager",
    displayName: "Account Manager agent",
    team: "CustomerSuccess",
    tools: ["account_360", "search_brain", "related_entities", "get_record"],
    role: "You own renewals and churn reviews for Wisteria's Customer Success team. You explain why a customer is leaving or staying, from calls, deals, Slack and the account record, and you decide what the account team does next.",
    color: 35,
  },
  {
    name: "revops_analyst",
    displayName: "RevOps agent",
    team: "Finance",
    tools: ["what_changed", "explain_data", "account_360", "search_brain"],
    role: "You are Wisteria's revenue operations analyst for Finance. You quantify revenue impact using Wisteria's governed definitions (ARR, churn) from OpenMetadata and say what Finance should report.",
    color: 33,
  },
  {
    name: "product_lead",
    displayName: "Product Lead agent",
    team: "Product",
    tools: ["search_brain", "related_entities", "account_360", "get_record"],
    role: "You run product at Wisteria. You turn what customers, support and sales are saying into product priorities: which features break, which gaps cost deals and what to fix first, from Jira, Confluence, Gong and Slack.",
    color: 34,
  },
];

export const agentByName = (name: string) => AGENTS.find((a) => a.name === name);
export const AGENT_NAMES: Record<string, string> = Object.fromEntries(AGENTS.map((a) => [a.name, a.displayName]));
/** the agent's AI application in OpenMetadata */
export const agentAppName = (a: WisteriaAgent) => `wisteria_${a.name}_agent`;

/** The demo: three agents, one account, one memory. Each picks up where the last one left off. */
export const scenario = (account: string) => [
  {
    agent: "support_lead",
    task: `Triage ${account}'s recent escalations. What is breaking for them, since when, and is it getting worse? Save what the account team needs to know.`,
  },
  {
    agent: "account_manager",
    task: `Prepare the churn review for ${account}. Start from what the team already knows, fill the gaps from calls, deals and Slack, and record the churn reason and what the account team should do.`,
  },
  {
    agent: "revops_analyst",
    task: `Quarter close: what is the revenue impact of ${account}, using Wisteria's governed ARR definition, and what should Finance report? Reuse the team's findings rather than re-investigating.`,
  },
];
