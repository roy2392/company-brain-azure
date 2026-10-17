#!/usr/bin/env bash
# Record the demo video on the Azure VM and fetch it (no SSH needed: Azure Run Command + a one-off download link).
#   ./infra/azure/demo/record.sh            # reset the team memory, record, speed up the waits → docs/demo/wisteria-agents-demo.mp4
#   ./infra/azure/demo/record.sh --keep     # keep the current team memory (no reset)
# The browser runs inside the VM's compose network (Playwright container) and talks to http://brain:8787 directly,
# so no password is typed anywhere. Needs: terraform outputs, az login, curl, ffmpeg and python3 locally.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TF="$ROOT/infra/azure/terraform"
RG=$(terraform -chdir="$TF" output -raw resource_group)
VM="vm-${RG#rg-}"
FQDN=$(terraform -chdir="$TF" output -raw fqdn)
SUB=$(sed -nE 's/^subscription_id *= *"([^"]+)".*/\1/p' "$TF/terraform.tfvars")
PW_VERSION=1.55.0
OUT="$ROOT/docs/demo"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
run() { az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts @"$1" --query "value[0].message" -o tsv | sed -E '/^\[(stdout|stderr)\]$/d;/^Enable succeeded/d'; }

RESET='docker exec -w /app brain_app npx tsx packages/brain/scripts/team-reset.ts'
[[ "${1:-}" == "--keep" ]] && RESET='echo "keeping the current team memory"'

cat > "$TMP/record.sh" <<EOF
set -e
cd /opt/brain/app
sudo -u brain bash -lc '$RESET'
rm -rf /opt/brain/data/demo && mkdir -p /opt/brain/data/demo
docker run --rm --network brain_net --ipc=host -v /opt/brain/app/infra/azure/demo:/demo:ro -v /opt/brain/data/demo:/out -w /tmp/rec \\
  mcr.microsoft.com/playwright:v$PW_VERSION-noble \\
  bash -lc 'npm init -y >/dev/null && npm i --no-audit --no-fund playwright@$PW_VERSION >/dev/null && cp /demo/record-demo.mjs . && node record-demo.mjs && cp /out/raw/*.webm /out/demo.webm'
mkdir -p /opt/brain/data/share && cp /opt/brain/data/demo/demo.webm /opt/brain/data/demo/segments.json /opt/brain/data/share/
ls -lh /opt/brain/data/share
EOF
echo "== recording on the VM (Playwright $PW_VERSION; several minutes)"
run "$TMP/record.sh"

echo "== fetching"
printf 'cat /opt/brain/env/share.token\n' > "$TMP/token.sh"
TOKEN=$(run "$TMP/token.sh" | tr -d '[:space:]')
curl -sf -o "$OUT/demo.webm" "https://$FQDN/share/$TOKEN/demo.webm"
curl -sf -o "$OUT/segments.json" "https://$FQDN/share/$TOKEN/segments.json"
printf 'rm -f /opt/brain/data/share/*\n' > "$TMP/clean.sh"
run "$TMP/clean.sh" >/dev/null

echo "== editing"
python3 "$ROOT/infra/azure/demo/speedup.py" "$OUT/demo.webm" "$OUT/segments.json" "$OUT/wisteria-agents-demo.mp4"
rm -f "$OUT/demo.webm"
ls -lh "$OUT/wisteria-agents-demo.mp4"
