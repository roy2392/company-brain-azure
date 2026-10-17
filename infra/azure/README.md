# Wisteria company brain on Azure

Everything the showcase needs, on Azure, defined in Terraform: OpenMetadata, MongoDB Atlas (Atlas Local), agent-memory,
the company brain, and four role agents in Microsoft Foundry that share one memory and answer from the catalog.
No laptop and no tunnel in the loop: the Foundry agents call the brain and OpenMetadata over HTTPS on the VM.

```
                       Microsoft Foundry (aif-<name> / project wisteria-agents, gpt-5.4)
                       ┌───────────────────────────────────────────────────────────────┐
                       │ wisteria-support-lead  wisteria-account-manager               │
                       │ wisteria-revops-analyst  wisteria-product-lead (prompt agents)│
                       │ each: 2 MCP tools, each behind a project connection holding   │
                       │ that agent's gateway key                                      │
                       └──────────────┬────────────────────────────────────────────────┘
                                      │ HTTPS  /agents/<agent>/mcp, /agents/<agent>/openmetadata/mcp
  people ── HTTPS ──┐                 ▼
   /team (basic     │   ┌──────────────────────── VM (Ubuntu 24.04, Docker Compose) ───────────────────────┐
   auth), :8443 OM  └──►│ Caddy (TLS, Let's Encrypt) ──► brain: web app + API :8787, Foundry gateway :8790 │
                        │                                 │            │                    │             │
                        │      OpenMetadata 2.0.5 ◄───────┘            ▼                    ▼             │
                        │      + Postgres + Elasticsearch       agent-memory :8000     Atlas Local 8.3.8  │
                        │      + Fuseki (RDF/SPARQL)            (shared memory) ─────► wisteria_brain,    │
                        │                                       Ollama (embeddings)    agent_memory       │
                        └──────────────────────────────────────────────────────────────────────────────────┘
```

## What Terraform creates (`terraform/`)

| File | Resources |
|---|---|
| `main.tf`, `network.tf` | resource group, VNet/subnet, NSG (22 from your IP; 80/443/8443 from the internet), static public IP with an Azure DNS name |
| `vm.tf`, `cloud-init.yaml.tftpl` | Ubuntu 24.04 VM (`Standard_D8s_v5`, 128 GB Premium SSD, system-assigned identity); cloud-init installs Docker and writes the generated settings and secrets to `/opt/brain` |
| `foundry.tf` | AI Services account (`allowProjectManagement`), project `wisteria-agents`, `gpt-5.4` GlobalStandard deployment, 8 MCP connections (2 per agent), `Cognitive Services User` for the VM identity |
| `secrets.tf` | OpenMetadata admin password, web basic-auth password, one gateway key per agent, OpenMetadata JWT signing key and Fernet key |
| `outputs.tf` | URLs, SSH command, Foundry endpoint; passwords as sensitive outputs |

The Foundry agents themselves are data-plane objects with no Terraform resource type. The VM creates them at the end
of the bootstrap with its managed identity (`npm run foundry:agents -- --agents-only`, instructions and tools in
`packages/brain/scripts/foundry-agents.ts`).

## Deploy

Prerequisites: Terraform ≥ 1.9, Azure CLI logged in to the subscription, an SSH key, `rsync`, and (for `--data`)
the laptop stack running with the brain's data in `brain_atlas`.

```bash
cd infra/azure/terraform
cp terraform.tfvars.example terraform.tfvars   # subscription, ssh key, your IP (curl -s https://api.ipify.org)
terraform init
terraform apply                                 # ~3 minutes
cd ../../..
./infra/azure/deploy.sh --data                  # sync the repo, ship the Atlas data, bootstrap (~15 minutes the first time)
```

`deploy.sh` waits for cloud-init, rsyncs the repo to `/opt/brain/app` (no `.env`, no state, no node_modules), copies
a `mongodump` of `wisteria_brain` the first time, then runs `infra/azure/vm/bootstrap.sh` on the VM, which:

1. writes the app's `.env` from `/opt/brain/env/azure.env` (Terraform's values),
2. converts the OpenMetadata signing key to DER and hashes the web password for Caddy,
3. `docker compose -f docker-compose.azure.yml up -d --build`,
4. replaces OpenMetadata's default `admin` password, pulls the Ollama models,
5. restores the Atlas data (first run), recreates the search indexes, runs `om:setup --no-native` (ontology, sources,
   collections, metrics, AI assets, lineage, the agents' bots), restarts Fuseki and the brain,
6. creates or updates the four Foundry agents, and checks the public endpoints.

Re-run `./infra/azure/deploy.sh` after code changes; every step is idempotent.

## Use it

```bash
terraform -chdir=infra/azure/terraform output app_url
terraform -chdir=infra/azure/terraform output -raw web_password                 # user: wisteria
terraform -chdir=infra/azure/terraform output openmetadata_url
terraform -chdir=infra/azure/terraform output -raw openmetadata_admin_password  # user: admin@open-metadata.org
```

- **`/team`**: pick an agent, chat (the turn runs in Foundry), and watch the right-hand panel: *Shared memory* lists
  agent-memory documents in Atlas as agents save them; *In OpenMetadata* shows the Context Center mirror (author =
  the agent's bot, owner = its team, linked to `agent_memory.memories`) and the memory table's lineage.
- **OpenMetadata** (`:8443`): Context Center → Memories; AI applications `wisteria_*_agent`; lineage of
  `wisteria_atlas.default.agent_memory.memories`.
- **Foundry portal**: the `wisteria-*` agents in project `wisteria-agents` (playground works from any network that
  can reach `*.services.ai.azure.com`).

## Record the demo video

```bash
./infra/azure/demo/record.sh     # resets the team memory, records, speeds up the waits → docs/demo/wisteria-agents-demo.mp4
```

See `demo/README.md` for the storyline.

## Operate

```bash
ssh brain@$(terraform -chdir=infra/azure/terraform output -raw vm_public_ip)
cd /opt/brain/app
docker compose -f docker-compose.azure.yml ps
docker logs -f brain_app                                            # gateway lines: [agent] → tool, ⟲ recall, ✚ remember
docker exec -w /app brain_app npx tsx packages/brain/scripts/team-reset.ts   # forget the team memory
docker exec -w /app brain_app npx tsx packages/brain/scripts/foundry-agents.ts --agents-only   # re-create agents
```

Teardown: `terraform -chdir=infra/azure/terraform destroy` (removes the VM, its data and the Foundry resources).

Cost while running: the VM (`D8s_v5`, ~US$0.38/h) dominates; model tokens are per use. Stop the VM between sessions
(`az vm deallocate -g <rg> -n <vm>`) and start it again before use; the containers restart on boot.

## Security model

- Internet-facing: only Caddy (80 → redirect, 443, 8443). Atlas, agent-memory, Fuseki, Postgres, Elasticsearch,
  Ollama and the brain's ports are closed in the NSG and only reachable on the compose network.
- Foundry → gateway: `/agents/<agent>/…` requires that agent's key (one random key per agent, stored only in its
  Foundry project connections and on the VM); one agent's key does not open another agent's endpoints.
- OpenMetadata tokens never leave the VM: the gateway forwards to OpenMetadata's MCP endpoint with the agent's own
  bot token, and only OpenMetadata's read tools pass (`create_*`/`patch_*` are refused).
- Each agent's OpenMetadata bot has the `WisteriaAgent` role: the Data Consumer policy plus create/edit on Context
  Center memories, nothing else (no delete).
- OpenMetadata uses its own JWT signing key and Fernet key (not the image defaults) and a generated admin password.
- The web app sits behind basic auth; SSH is limited to `ssh_allowed_cidrs`.
- Terraform state contains the generated secrets: keep it local (git-ignored) or move it to a locked-down backend.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `deploy.sh` cannot SSH | Your egress IP changed: update `ssh_allowed_cidrs`, `terraform apply`. |
| Caddy has no certificate | Port 80 must be reachable for Let's Encrypt; check `docker logs brain_caddy`. |
| Agents answer "tool failed" | `docker logs brain_app` shows each gateway call; a 401 means the key in the Foundry connection and `FOUNDRY_AGENT_KEYS` differ (re-apply Terraform, re-run deploy). |
| Elasticsearch restarts | `vm.max_map_count` must be 262144 (cloud-init sets it; `sysctl vm.max_map_count`). |
| Foundry calls fail from a corporate laptop | Some corporate network clients (e.g. Global Secure Access) block `*.services.ai.azure.com` for other tenants. The VM is not affected; use `/team` or record with `demo/record.sh`. |
