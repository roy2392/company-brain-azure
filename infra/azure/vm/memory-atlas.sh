#!/usr/bin/env bash
# On the VM (run by infra/azure/memory-to-atlas.sh): point agent-memory and the brain at the Atlas cluster in
# /opt/brain/env/atlas.env (or back at Atlas Local when that file is gone), re-catalog the memory in OpenMetadata
# and start the team memory fresh. agent-memory creates its collections and search indexes on the cluster at startup.
set -euo pipefail
cd /opt/brain/app
C="docker compose -f docker-compose.azure.yml"

sed -i '/^AGENT_MEMORY_MONGODB_URI=/d' .env
if [ -f /opt/brain/env/atlas.env ]; then
  cat /opt/brain/env/atlas.env >> .env
  echo "memory → Atlas cluster"
  # A free (M0) cluster holds only 3 search indexes and agent-memory wants 5: create the two the agents' recall needs
  # first, copied from agent-memory's own definitions on Atlas Local.
  # shellcheck disable=SC1091
  . /opt/brain/env/atlas.env
  docker exec -e URI="$AGENT_MEMORY_MONGODB_URI" brain_atlas mongosh --quiet agent_memory --eval '
    const defs = db.memories.getSearchIndexes().map((i) => ({ name: i.name, type: i.type || "search", definition: i.latestDefinition }));
    const remote = connect(process.env.URI.replace("/?", "/agent_memory?"));
    if (!remote.getCollectionNames().includes("memories")) remote.createCollection("memories");
    const have = remote.memories.getSearchIndexes().map((i) => i.name);
    for (const d of defs) if (!have.includes(d.name)) { remote.memories.createSearchIndex(d); print("search index", d.name, "created"); }
  ' || echo "could not pre-create the memory search indexes (agent-memory will try)"
else
  echo "memory → Atlas Local"
fi

$C up -d --no-deps agent-memory 2>&1 | tail -1
for _ in $(seq 1 60); do [ "$(docker inspect -f '{{.State.Health.Status}}' brain_agent_memory)" = healthy ] && break; sleep 5; done
docker inspect -f 'agent-memory: {{.State.Health.Status}}' brain_agent_memory

docker restart brain_app >/dev/null # reinstalls and rebuilds on start
for _ in $(seq 1 90); do docker exec brain_app curl -sf http://localhost:8787/api/status >/dev/null 2>&1 && break; sleep 5; done
docker exec -w /app brain_app npx tsx packages/brain/scripts/om-setup.ts --agents-only 2>&1 | tail -2
docker exec -w /app brain_app npx tsx packages/brain/scripts/team-reset.ts
