#!/usr/bin/env bash
# Ship the Era by Eon tokens from the local .env to the VM (/opt/brain/env/era.env, mode 600), for jobs that call
# Era from the VM, such as the time-lapse sync (`docker exec --env-file /opt/brain/env/era.env ...`). The tokens are
# read-only (Era's simulators refuse writes). Run Command only, no SSH; nothing is printed.
#   ./infra/azure/era-to-vm.sh          # ship the tokens
#   ./infra/azure/era-to-vm.sh --off    # remove them from the VM
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TF="$ROOT/infra/azure/terraform"
RG=$(terraform -chdir="$TF" output -raw resource_group)
VM="vm-${RG#rg-}"
SUB=$(sed -nE 's/^subscription_id *= *"([^"]+)".*/\1/p' "$TF/terraform.tfvars")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [[ "${1:-}" == "--off" ]]; then
  echo 'rm -f /opt/brain/env/era.env' > "$TMP/env.sh"
else
  ENV_LINES=$(grep -E '^ERA_[A-Z_]+=' "$ROOT/.env" || true)
  [[ -n "$ENV_LINES" ]] || { echo "No ERA_* lines in $ROOT/.env (run npm run era:import first)."; exit 1; }
  ENV_B64=$(printf '%s\n' "$ENV_LINES" | base64 | tr -d '\n')
  printf 'umask 077; echo %s | base64 -d > /opt/brain/env/era.env; chown brain:brain /opt/brain/env/era.env; echo "era.env: $(grep -c . /opt/brain/env/era.env) lines"\n' "$ENV_B64" > "$TMP/env.sh"
fi
az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts @"$TMP/env.sh" \
  --query "value[0].message" -o tsv | sed -E '/^\[(stdout|stderr)\]$/d;/^Enable succeeded/d'
