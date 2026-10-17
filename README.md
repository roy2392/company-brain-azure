# Wisteria Company Brain

A working company brain for **Wisteria Group**, the Era by Eon synthetic company (B2B fintech, 20k employees, 6k customers).
It ingests Salesforce, Zendesk, Gong, Slack, Jira, Confluence and Google Drive into **MongoDB Atlas**, catalogs and governs it in
**OpenMetadata**, and answers questions with citations — in a web app and, through MCP, in Claude. Three role agents
(Support Lead, Account Manager, RevOps) share one memory through [agent-memory](https://github.com/mongodb-partners/agent-memory)
on the same Atlas, and OpenMetadata records their runs and memories.

```
Era · Wisteria (6 read-only connectors)
        │  TypeScript connectors (vendor-shaped REST, cached on disk)
        ▼
MongoDB Atlas  wisteria_brain
  raw_<system>_<object>   verbatim records
  docs                    citable units (ticket, call, thread, page, opportunity…)
  entities                accounts · people · products + links      → $graphLookup
  chunks                  text + embeddings → Atlas Search + Vector Search → $rankFusion
        │                                     ▲
        ▼                                     │ definitions, owners, lineage at answer time
OpenMetadata 2.0.5  domains · glossary · teams/owners · Era source services · Atlas service · lineage
        │
Brain tools: search_brain · account_360 · related_entities · what_changed · explain_data · get_record · team_memory
  ├─ MCP server (stdio)  → Claude Desktop / Claude Code
  └─ Web app (Vite/React) → Claude Agent SDK → streamed, cited answers + evidence vine + lineage

Wisteria agents (Support Lead → Account Manager → RevOps), Claude Agent SDK + brain tools + memory tools
        │  recall_team_memory · remember · team_activity
        ▼
agent-memory :8000 (REST + MCP)  →  MongoDB Atlas  agent_memory: memories · episodes · decisions
        │
OpenMetadata: AI applications · agent executions · Context Center memories · lineage agents → memories → brain
```

## Run it

Prerequisites: Docker (8 GB), Node 22, Ollama with `ollama pull nomic-embed-text` and `ollama pull qwen2.5:3b`
(the second one enriches agent memories).

```bash
npm install
cp .env.example .env
docker compose up -d                      # Atlas Local + OpenMetadata + agent-memory (about 3 min on first start)
```

Connect Era: in the Era console click **Connect**, create a token and copy the six `claude mcp add …` commands, then:

```bash
npm run era:import -- --register          # tokens → .env (never printed) + adds the MCP servers to Claude Code
npm run era:probe                         # optional: what each connector exposes
npm run ingest                            # Era → Atlas (cached; re-runs are cheap); BRAIN_FOCUS_NAMES picks demo accounts
npm run om:setup                          # OpenMetadata: semantics, sources, Atlas collections, lineage, owners
npm run smoke                             # checks every layer without the LLM
```

Model access for the agent (one of): `ANTHROPIC_API_KEY=…` in `.env`, or Microsoft Foundry
(`CLAUDE_CODE_USE_FOUNDRY=1` plus the `ANTHROPIC_FOUNDRY_*` variables).

```bash
npm run dev                               # API :8787 + UI http://localhost:3100
```

OpenMetadata UI: http://localhost:8585 (local quickstart login `admin@open-metadata.org` / `admin`).

### Use the brain from Claude

```bash
claude mcp add wisteria-brain -- npx tsx ~/Projects/company-brain-showcase/packages/brain/src/mcp/server.ts
```

Or ask it from the terminal (same agent as the web app):

```bash
npm run ask -- "Which datasets with personal data feed the Company Brain agent, and who owns them?"
```

### OpenMetadata's MCP server

OpenMetadata 2.x ships its own MCP server at `http://localhost:8585/mcp` (search, entity details, lineage, company
context, plus write tools). `npm run om:mcp` creates a read-only `company-brain-bot` (DataConsumer role), stores its
token in `.env` and lists the tools; `npm run om:mcp -- --register` also adds the `openmetadata` server to Claude Code
for this project. The brain agent connects to it automatically when the token is present, with the write tools
blocked, and OpenMetadata catalogs it as one of the agent's tools.

### Agents with a shared memory (agent-memory)

Three Wisteria role agents run on the Claude Agent SDK, each with a subset of the brain tools plus three memory tools:
`recall_team_memory`, `remember` and `team_activity`. They all use one memory space (`AGENT_MEMORY_TEAM`) in
[agent-memory](https://github.com/mongodb-partners/agent-memory), which runs as the `agent-memory` compose service on
:8000 and stores short-term, long-term and episodic memory in the `agent_memory` database of the same Atlas. Embeddings
come from Ollama (`nomic-embed-text`), and a local `qwen2.5:3b` enriches long-term memories.

```bash
npm run agents                            # Support Lead → Account Manager → RevOps on Novaris Holdings
npm run agents -- --account "Ironwood Group"
npm run agents -- --only revops_analyst   # one agent, on whatever the team already remembers
npm run agents -- --reset                 # forget the team memory first (Atlas + the OpenMetadata mirror)
npm run agents -- --sync                  # record journaled runs OpenMetadata missed
```

Each agent recalls the team memory first and only investigates the gaps; in the rehearsal run the tool calls went
14 → 11 → 7. In OpenMetadata, `npm run om:setup` catalogs the three agents as AI applications (owned by Support,
Customer Success and Finance), agent-memory as an MCP server, the `agent_memory` collections, and lineage
brain → agents → `agent_memory.memories` → `company_brain_agent`. Every run becomes an agent execution (tool calls,
data read and written, cost) and every saved memory a shared Context Center memory scoped to the agent that wrote it,
authored by that agent's own bot user (`support-lead-agent`, `account-manager-agent`, `revops-analyst-agent`, role
`WisteriaAgent`: read the catalog, create and edit memories, no delete).
Runs are journaled in `.cache/agent-runs` first, so a catalog outage is repaired with `--sync`. The brain's own
`team_memory` tool lets the web app answer "what do our agents already know about Novaris Holdings?".

agent-memory is not on PyPI; `infra/agent-memory/Dockerfile` builds a pinned commit and installs the exact versions in
its `uv.lock` with `--require-hashes`. Where `files.pythonhosted.org` is blocked, set `AGENT_MEMORY_PIP_INDEX_URL` to a
PyPI mirror: the hashes still have to match PyPI's.

### Ontology and knowledge graph (RDF / SPARQL)

`npm run om:setup` builds the Wisteria ontology in OpenMetadata: 27 concepts as an is-a hierarchy, 18 typed relation
types (works for, owns, about, raised by, escalates to, indicates… with inverses), mappings to schema.org, FIBO,
W3C ORG and FOAF, and 5 governed metrics. With RDF enabled, OpenMetadata projects the catalog into Apache Jena Fuseki,
and the setup adds a small OWL graph (subclasses, inverse properties, transitive `wst:dependsOn` over lineage) so
reasoners can use it.

```bash
npm run sparql                            # list the demo queries
npm run sparql -- 1                       # the ontology map
npm run sparql -- 2 --compare             # RDFS: every kind of Person (2 → 4 with the reasoner)
npm run sparql -- 3 --compare             # OWL: PII datasets the agent depends on (0 → 16 with the reasoner)
```

Plain queries go through OpenMetadata's API (`/api/v1/rdf/sparql`). Inference runs in the Fuseki services
`openmetadata_rdfs` and `openmetadata_owl` (Jena RDFS rules and OWL Micro), because OpenMetadata 2.0.5's own
`inference=` option fails against Fuseki. Fuseki UI: http://localhost:3030. After enabling RDF on an existing
catalog, run `npm run om:setup -- --rdf-reindex` once.

### Run it on Azure (with Microsoft Foundry agents)

`infra/azure/` deploys the whole stack to one Azure VM with Terraform (OpenMetadata, Atlas Local, agent-memory,
Ollama, the brain behind Caddy/TLS) and creates four role agents in Microsoft Foundry that call the brain, the shared
memory and OpenMetadata over MCP. `/team` lets you chat with each agent and watch the shared memory fill up in Atlas
and in OpenMetadata. See [infra/azure/README.md](infra/azure/README.md); coding agents start with [AGENTS.md](AGENTS.md).

### Run on Atlas cloud

Set `MONGODB_URI=mongodb+srv://…` and re-run `npm run ingest`. Search and vector indexes are created automatically.
`$rankFusion` needs MongoDB 8.1+; on older tiers the brain fuses results itself (RRF). For OpenMetadata, edit the
`wisteria_atlas` service connection in the UI (the dockerized connector only reaches the local container).

## Demo script (Sunday)

1. **The silos.** Open the Era console: six systems, one company. Then the app — the vine shows what's in memory.
2. **Ask across silos.** "Is Acacia Partners at risk of churning? Show me the evidence." Watch blossoms open per system;
   click a citation to open the Zendesk thread or Gong transcript it came from.
3. **What changed.** "What changed at Wisteria this quarter?" (Era's environment was moved one quarter forward).
4. **Governed answers.** "How do we define ARR, and who owns that number?" → OpenMetadata glossary term, owner, lineage.
   Open OpenMetadata: domains, the `Customer360Brain` data product, lineage Era → Atlas → agent, PII tags,
   the Customer term's relations graph. Then `npm run sparql -- 3 --compare`: the reasoner finds every PII dataset
   the agent depends on from one-hop lineage facts.
5. **Any agent.** Same question in Claude Code with the `wisteria-brain` MCP server.
6. **Three agents, one memory.** `npm run agents -- --only revops_analyst`: it recalls six memories from its teammates.
   Then in OpenMetadata: Context Center memories, an agent's executions, the lineage of `agent_memory.memories`.

Rehearsal checklist: `docker compose ps` all healthy, `npm run smoke` passes, one warm-up question in the UI,
OpenMetadata logged in on a second tab, Era console open on a third.

## Layout

```
docker-compose.yml               Atlas Local + include infra/openmetadata.compose.yml (OM 2.0.5, Airflow removed)
infra/agent-memory*              agent-memory service (pinned commit, hash-checked deps)
packages/brain/src
  era/client.ts                  auth'd REST + MCP client, retries, disk cache (.cache/era)
  era/connectors/*.ts            salesforce (runs first: accounts + focus), slack, zendesk, gong, atlassian, drive
  brain/                         store + indexes, embeddings, chunking, entities, hybrid search, tools
  om/                            OpenMetadata client, catalog builder, native MongoDB connector runner, agent assets
  agents/                        role agents, shared-memory client (agent-memory REST), run journal
  agent.ts, server.ts, mcp/      Agent SDK loop, HTTP API (SSE), MCP server
apps/web                         showcase UI
docs/superpowers/specs           design
```
