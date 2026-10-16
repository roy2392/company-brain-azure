# Company Brain Showcase — Design

Date: 2026-10-15 · Demo: Sunday 2026-10-18 · Status: approved ("ok go"), defaults taken

## 1. Intent

Build a working "company brain" for **Wisteria Group** — the Era by Eon synthetic company
(B2B fintech, 20k employees, 6k customers) — on **MongoDB Atlas** (content + retrieval) and
**OpenMetadata** (catalog, semantics, governance). Mixed business + technical audience.

Success on Sunday = these four moments work live:

1. **Ask across silos.** "Is Acacia Partners at risk? Why?" — one answer fused from Salesforce,
   Zendesk, Gong, Slack, Jira/Confluence and Drive, every claim cited back to its source record.
2. **What changed this quarter.** A timeline diff across all systems for the last 91 days
   (uses Era's point-in-time: the environment is moved one quarter forward).
3. **Governed answers.** "Where does ARR come from and who owns it?" — answered from
   OpenMetadata: glossary definition, owner, domain, lineage Salesforce → Atlas → Brain.
4. **Any agent can use it.** The same brain tools exposed as an MCP server, used from Claude.

Assumptions (not stated by the user): curated slice of data, not all 100k+ records; local
OpenMetadata in Docker; local embeddings (Ollama) because no API keys exist yet.

## 2. Architecture

```
Era · Wisteria Group (read-only, bearer token per connector)
  Salesforce · Zendesk · Gong · Slack · Jira/Confluence · Google Drive
        │  connectors (vendor-shaped REST; MCP for discovery)  → normalized records
        ▼
MongoDB Atlas  ─ db wisteria_brain ────────────────────────────────────────────
  raw_<source>_<object>  verbatim vendor JSON + _brain{source, fetchedAt}
  entities               account | person | product, aliases, links[] (graph edges)
  chunks                 text, source, url, ts, entityIds, embedding[768]
                           ├─ Atlas Search index   chunks_text   (BM25, facets)
                           └─ Vector Search index  chunks_vector (cosine)
  timeline               dated events per entity (opp stage moves, tickets, calls…)
        │                                   ▲
        │ OM MongoDB connector              │ brain tools read OM at answer time
        ▼                                   │
OpenMetadata 2.0.5 ─ catalog of the brain ──┘
  services: era_* (CustomDatabase, one per Era system), wisteria_atlas (MongoDB),
            brain_pipelines (CustomPipeline), company_brain_agent (AI application) + LLMs + MCP servers
  lineage:  era_salesforce.Opportunity → raw_salesforce_opportunity → docs → chunks → metrics → agent (column level)
  ontology: "Wisteria Business Glossary" as an is-a hierarchy, typed relations (worksFor, owns, about…),
            schema.org/FIBO concept mappings, governed metrics, PII tags, teams/owners from Era org

Brain tools (one TypeScript module)
  search_brain · account_360 · related_entities ($graphLookup) · what_changed · explain_data (OM)
    ├─ MCP server (stdio)            → Claude Desktop / Claude Code
    └─ Web app (Next.js) → Claude Agent SDK (tools in-process) → chat, citations, 360 card, lineage
```

## 3. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `era/client` | Auth'd fetch per connector, retries, on-disk cache (`.cache/era`) so re-runs don't burn calls | `.env` tokens |
| `era/connectors/*` | One file per system: pull a scoped slice, map to `RawRecord` + `Doc` (text for chunking) + entity refs | client |
| `brain/store` | Collections, indexes (incl. search + vector index creation, idempotent) | mongodb |
| `brain/embed` | `Embedder` interface; Ollama (default) and Voyage implementations | — |
| `brain/chunk` | Split docs into ~1.2k-char chunks with header context | — |
| `brain/entities` | Resolve accounts/people across systems (name/email/domain normalisation), write edges | store |
| `brain/search` | Hybrid retrieval: `$rankFusion` of `$search` + `$vectorSearch`, entity/source filters; app-side RRF fallback | store, embed |
| `brain/tools` | The five tools above, returning text + structured citations | search, store, om |
| `om/client` | Login, bot token, typed PUT/PATCH helpers | OpenMetadata REST |
| `om/catalog` | Idempotent setup: domains, glossary, tags, teams/users, services, tables, lineage | om/client, store |
| `mcp/server` | stdio MCP server wrapping `brain/tools` | tools |
| `apps/web` | Next.js UI + `/api/chat` streaming route using the Agent SDK | tools |

## 4. Ingestion scope

- Org-wide: Salesforce accounts/opportunities/contracts/products, Confluence pages, Drive docs,
  Jira projects/issues (recent), Slack `#general` (recent), Era org (users, titles).
- Deep context for `BRAIN_FOCUS_ACCOUNTS` (default 40) customer accounts with the most activity:
  their Slack channels, Gong calls, Zendesk tickets, Salesforce cases/tasks.
- Everything cached on disk; ingestion is resumable and idempotent (upsert by source id).

## 5. Agent

Claude Agent SDK `query()` with the brain tools as an in-process MCP server, built-in tools
disabled, `settingSources: []`. Auth comes from the environment: `ANTHROPIC_API_KEY` or Microsoft
Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`). System prompt: always cite, prefer governed definitions
from OpenMetadata, say when data is missing.

## 6. Error handling

- Era: 401 → clear "token missing/expired" message naming the connector; 429/5xx → backoff.
- Missing embeddings provider → ingestion still runs; search falls back to text-only.
- OM unavailable → tools return answers without catalog context and say so.
- Every tool returns `isError` with a human message instead of throwing into the agent loop.

## 7. Testing

- Unit (vitest): chunking, entity normalisation, RRF fusion, connector mappers on fixture JSON.
- Smoke (`npm run smoke`): Atlas counts per collection, a hybrid query returns cited results,
  OM has the services, glossary and lineage edges.
- Demo rehearsal checklist in README (the four moments above).
