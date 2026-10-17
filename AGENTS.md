# AGENTS.md: working in this repository

Wisteria company brain: Era by Eon's synthetic company (Salesforce, Zendesk, Gong, Slack, Jira/Confluence, Google
Drive) ingested into MongoDB Atlas, governed in OpenMetadata, answered by agents. Runs on a laptop (Docker) or on
Azure (Terraform). Read this before changing anything.

## Map

| Path | What |
|---|---|
| `packages/brain/src/era/` | Era connectors (vendor REST, disk cache in `.cache/era`) |
| `packages/brain/src/brain/` | Atlas store, embeddings (Ollama), chunking, entities, hybrid search (`$rankFusion`), the brain tools |
| `packages/brain/src/om/` | OpenMetadata client and catalog builder (`catalog.ts`), ontology, RDF/Fuseki, MCP bot, agent assets (`agents.ts`) |
| `packages/brain/src/agents/` | the role agents: roster, shared memory client (agent-memory REST), shared memory tools, Claude Agent SDK runner, run journal |
| `packages/brain/src/foundry/` | Microsoft Foundry: tokens (managed identity or az), chat (Responses API), per-agent gateway keys |
| `packages/brain/src/gateway.ts` | the only door Foundry agents get: per-agent MCP (brain + memory tools) and OpenMetadata MCP proxy (read tools only) |
| `packages/brain/src/server.ts` | HTTP API: `/api/chat` (Claude brain agent), `/api/team/*` (Foundry agents, memory feed, catalog view) |
| `packages/brain/scripts/` | `ingest`, `om-setup`, `agents` (Claude agents), `foundry-agents`, `team-reset`, `indexes`, `smoke`, `sparql` |
| `apps/web/` | React UI: `/` the cited brain chat, `/team` the Foundry agent team with live shared memory |
| `docker-compose.yml` | laptop stack (Atlas, OpenMetadata, Fuseki, agent-memory) |
| `docker-compose.azure.yml` | Azure VM stack (same + Ollama, brain, Caddy) |
| `infra/azure/terraform/` | everything on Azure (VM, network, Foundry account/project/model/connections, secrets, role) |
| `infra/azure/vm/` | VM bootstrap, Caddyfile, OpenMetadata override |
| `infra/azure/deploy.sh` | sync repo → VM, ship data, bootstrap (SSH) |
| `infra/azure/push.sh` | same without SSH: ship code / run commands through Azure Run Command |
| `infra/azure/demo/` | demo video recorders: the real Foundry + OpenMetadata portals (`record-portal.sh`, in the VM's portal browser) and the `/team` page (`record.sh`) |

## Commands

```bash
npm install
docker compose up -d                 # laptop stack
npm run ingest                       # Era → Atlas
npm run om:setup                     # OpenMetadata catalog (idempotent)
npm run smoke                        # every layer, no LLM
npm test                             # unit tests (vitest)
npx tsc --noEmit -p packages/brain && npx tsc --noEmit -p apps/web
npm run agents                       # Claude role agents on the laptop (needs Claude access)
npm run dev                          # API :8787 + UI :3100
```

Azure: see `infra/azure/README.md` (`terraform apply`, `./infra/azure/deploy.sh --data`, `./infra/azure/demo/record-portal.sh`).

## Invariants (do not break)

- **Secrets never in git or logs.** `.env`, `*.tfvars`, Terraform state and `.cache/` are git-ignored. Never print
  Era tokens, OpenMetadata JWTs, gateway keys or passwords. On Azure, secrets come from Terraform and live in
  `/opt/brain/env` (mode 600) and the app's generated `.env`.
- **One shared memory space.** Every agent reads and writes agent-memory `user_id = AGENT_MEMORY_TEAM`
  (`wisteria-revenue-team`); authorship is in tags (`agent:<name>`, `account:<id>`, `topic:<t>`). Memory tools are
  defined once in `agents/memory-tools.ts` for both runtimes.
- **Memories are mirrored to OpenMetadata** as Context Center memories written by the agent's own bot
  (`<role>-agent`, role `WisteriaAgent`). Atlas stays the memory of record.
- **Gateway rules:** a key opens only its own agent's endpoints; OpenMetadata tokens stay on the server; only
  `OM_MCP_READ_TOOLS` pass. Keep it that way when adding routes.
- **Cite everything.** Tools return `[[source:kind:id]]` markers; agents must cite and never invent ids.
- **Roster changes touch three places:** `agents/roster.ts`, Terraform `var.agents` (connections + keys), then
  `npm run om:setup` (AI application + bot) and `foundry-agents` (Foundry agent).

## Gotchas

- OpenMetadata 2.0.5: see `docs/` and the comments in `om/*.ts` (PUT is create-or-update; glossary `iri` needs PATCH;
  teams must be `Group` to own assets; `metrics.cost` and non-UUID `sourceConversation` are rejected; agent execution
  DELETE is a no-op).
- `$rankFusion` needs MongoDB 8.1+ (Atlas Local 8.3 here); older tiers fall back to app-side RRF.
- agent-memory is built from a pinned commit with hash-checked dependencies (`infra/agent-memory/Dockerfile`).
- Corporate network clients may block `*.services.ai.azure.com` (and SSH) for non-corporate tenants; the Azure VM is
  unaffected. Operate it with `infra/azure/push.sh` (Run Command) and record with `infra/azure/demo/record-portal.sh` (the portal browser: `infra/azure/vm/portal-up.sh`, you sign in over noVNC; `portal-down.sh` deletes the session).
- Foundry fails a whole response when one MCP tool errors: keep gateway tool failures as text, keep tool inputs
  lenient (clamp in code, no strict enums/min/max), and only expose OpenMetadata tools that work without its vector
  search (`OM_MCP_AGENT_TOOLS`).
