#!/usr/bin/env bash
# Start the portal browser (Chromium in Azure behind noVNC on :8444) and refresh what it depends on.
# Run on the VM from /opt/brain/app (./infra/azure/push.sh "bash infra/azure/vm/portal-up.sh").
# Stop and forget the signed-in session afterwards with infra/azure/vm/portal-down.sh.
set -euo pipefail
cd /opt/brain/app
C="docker compose -f docker-compose.azure.yml"

[ -f /opt/brain/env/browser.password ] || (umask 077; openssl rand -base64 24 | tr -d '/+=' > /opt/brain/env/browser.password)
if ! grep -q BROWSER_PASSWORD_HASH /opt/brain/env/caddy.env; then
  BHASH=$(docker run --rm caddy:2 caddy hash-password --plaintext "$(cat /opt/brain/env/browser.password)")
  printf 'BROWSER_USER=wisteria\nBROWSER_PASSWORD_HASH=%s\n' "$BHASH" >> /opt/brain/env/caddy.env
fi
if ! grep -q '^SITE_HOST=' .env; then
  H=$(sed -nE "s/^SITE_HOST='?([^']+)'?$/\1/p" /opt/brain/env/azure.env)
  sed -i "2i SITE_HOST=$H" .env
fi

$C up -d caddy 2>&1 | tail -1
$C --profile portal up -d --build portal-browser 2>&1 | tail -1
for _ in $(seq 1 30); do docker logs brain_portal_browser 2>&1 | grep -q "portal browser ready" && break; sleep 2; done
docker logs --tail 2 brain_portal_browser 2>&1
