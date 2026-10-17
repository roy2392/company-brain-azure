#!/usr/bin/env bash
# Record the demo video on the Azure VM and fetch it.
#   ./infra/azure/demo/record.sh            # reset the team memory, record, speed up the waits → docs/demo/wisteria-agents-demo.mp4
#   ./infra/azure/demo/record.sh --keep     # keep the current team memory (no reset)
# The browser runs inside the VM's compose network (Playwright container) and talks to http://brain:8787 directly,
# so no password is typed anywhere. Needs: terraform outputs, ssh, ffmpeg and python3 locally.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TF="$ROOT/infra/azure/terraform"
IP=$(terraform -chdir="$TF" output -raw vm_public_ip)
USER_NAME=$(terraform -chdir="$TF" output -raw admin_username)
TARGET="$USER_NAME@$IP"
PW_VERSION=1.55.0
OUT="$ROOT/docs/demo"
mkdir -p "$OUT"

rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" "$ROOT/infra/azure/demo/" "$TARGET:/opt/brain/app/infra/azure/demo/"
if [[ "${1:-}" != "--keep" ]]; then
  echo "== resetting the team memory (agent-memory + OpenMetadata mirror)"
  ssh "$TARGET" 'docker exec -w /app brain_app npx tsx packages/brain/scripts/team-reset.ts'
fi

echo "== recording (Playwright $PW_VERSION on the VM)"
ssh "$TARGET" "rm -rf /opt/brain/data/demo && mkdir -p /opt/brain/data/demo && docker run --rm --network brain_net --ipc=host \
  -v /opt/brain/app/infra/azure/demo:/demo:ro -v /opt/brain/data/demo:/out -w /tmp/rec \
  mcr.microsoft.com/playwright:v$PW_VERSION-noble \
  bash -lc 'npm init -y >/dev/null && npm i --no-audit --no-fund playwright@$PW_VERSION >/dev/null && cp /demo/record-demo.mjs . && node record-demo.mjs && cp /out/raw/*.webm /out/demo.webm'"

echo "== fetching and editing"
scp "$TARGET:/opt/brain/data/demo/demo.webm" "$TARGET:/opt/brain/data/demo/segments.json" "$OUT/"
python3 "$ROOT/infra/azure/demo/speedup.py" "$OUT/demo.webm" "$OUT/segments.json" "$OUT/wisteria-agents-demo.mp4"
rm -f "$OUT/demo.webm"
ls -lh "$OUT/wisteria-agents-demo.mp4"
