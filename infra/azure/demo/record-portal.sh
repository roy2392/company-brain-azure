#!/usr/bin/env bash
# Record the demo in the real portals (Foundry playground, then OpenMetadata) inside the VM's portal browser, and fetch it.
#   ./infra/azure/demo/record-portal.sh                  # reset the team memory, record → docs/demo/wisteria-portal-demo.mp4
#   ./infra/azure/demo/record-portal.sh --keep           # keep the current team memory
#   SCENES=om DRY=1 ./infra/azure/demo/record-portal.sh --keep   # rehearse only the OpenMetadata part, no video
#   SCENES=traces VIDEO=test.mp4 ./infra/azure/demo/record-portal.sh --keep   # test one scene into another file
# Needs the portal browser up (vm/portal-up.sh) and signed in to ai.azure.com and OpenMetadata (you sign in, over noVNC).
# Everything runs through Azure Run Command; the video comes back through a one-off download link.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TF="$ROOT/infra/azure/terraform"
RG=$(terraform -chdir="$TF" output -raw resource_group)
VM="vm-${RG#rg-}"
FQDN=$(terraform -chdir="$TF" output -raw fqdn)
ENDPOINT=$(terraform -chdir="$TF" output -raw foundry_project_endpoint)   # https://<account>.services.ai.azure.com/api/projects/<project>
ACCOUNT=$(sed -E 's#https://([^.]+)\..*#\1#' <<<"$ENDPOINT")
PROJECT=$(sed -E 's#.*/projects/([^/?]+).*#\1#' <<<"$ENDPOINT")
SUB=$(sed -nE 's/^subscription_id *= *"([^"]+)".*/\1/p' "$TF/terraform.tfvars")
OUT="$ROOT/docs/demo"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$OUT"
run() { az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts @"$1" --query "value[0].message" -o tsv | sed -E '/^\[(stdout|stderr)\]$/d;/^Enable succeeded/d'; }

RESET='docker exec -w /app brain_app npx tsx packages/brain/scripts/team-reset.ts'
[[ "${1:-}" == "--keep" ]] && RESET='echo "keeping the current team memory"'

cat > "$TMP/record.sh" <<EOS
set -e
cd /opt/brain/app
$RESET
mkdir -p /opt/brain/data/demo /opt/brain/data/share && rm -f /opt/brain/data/demo/portal-* /opt/brain/data/demo/failed-*
docker exec -u root brain_portal_browser bash -c 'command -v xdotool >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xdotool >/dev/null)'
docker exec -e AZURE_SUBSCRIPTION_ID=$SUB -e AZURE_RESOURCE_GROUP=$RG -e FOUNDRY_ACCOUNT=$ACCOUNT -e FOUNDRY_PROJECT=$PROJECT \\
  -e OM_URL=https://$FQDN:8443 -e SCENES=${SCENES:-foundry,om} -e DRY=${DRY:-} \\
  brain_portal_browser sh -c 'cp /demo/portal-record.mjs /app/ && cd /app && node portal-record.mjs' 2>&1 | tail -40 || true
cp /opt/brain/data/demo/portal-* /opt/brain/data/demo/failed-* /opt/brain/data/share/ 2>/dev/null || true
ls -lh /opt/brain/data/share | tail -n +2
EOS
echo "== recording in the portal browser (several minutes)"
run "$TMP/record.sh"

printf 'cat /opt/brain/env/share.token\n' > "$TMP/token.sh"
TOKEN=$(run "$TMP/token.sh" | tr -d '[:space:]')
get() { curl -sf -o "$2" "https://$FQDN/share/$TOKEN/$1" && echo "fetched $1"; }
get failed-foundry.png "$OUT/failed-foundry.png" || true
get failed-om.png "$OUT/failed-om.png" || true
if [[ -z "${DRY:-}" ]]; then
  get portal-raw.mp4 "$TMP/raw.mp4"
  get portal-segments.json "$TMP/segments.json"
fi
printf 'rm -f /opt/brain/data/share/*\n' > "$TMP/clean.sh"
run "$TMP/clean.sh" >/dev/null
[[ -n "${DRY:-}" ]] && exit 0

echo "== editing (agents' thinking time sped up)"
python3 "$ROOT/infra/azure/demo/speedup.py" "$TMP/raw.mp4" "$TMP/segments.json" "$OUT/${VIDEO:-wisteria-portal-demo.mp4}" "${SPEEDUP:-8}"
ls -lh "$OUT/${VIDEO:-wisteria-portal-demo.mp4}"
