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
