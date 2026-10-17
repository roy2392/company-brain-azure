#!/usr/bin/env bash
# Stop the portal browser and delete its profile (the signed-in Azure/OpenMetadata sessions live there).
set -euo pipefail
cd /opt/brain/app
docker compose -f docker-compose.azure.yml --profile portal rm -sf portal-browser >/dev/null 2>&1 || true
docker volume rm -f "$(docker volume ls -q | grep portal-profile)" >/dev/null 2>&1 || true
echo "portal browser stopped, profile deleted"
