#!/usr/bin/env bash
# Move the agents' shared memory onto the MongoDB Atlas cluster from terraform/atlas.tf, after terraform apply:
# ship its connection string to the VM (/opt/brain/env/atlas.env, which bootstrap.sh also reads), point agent-memory
# and the brain at it, re-catalog it in OpenMetadata and reset the team memory. Run Command only, no SSH.
#   ./infra/azure/memory-to-atlas.sh          # memory on Atlas
#   ./infra/azure/memory-to-atlas.sh --off    # back to Atlas Local on the VM
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TF="$ROOT/infra/azure/terraform"
RG=$(terraform -chdir="$TF" output -raw resource_group)
VM="vm-${RG#rg-}"
SUB=$(sed -nE 's/^subscription_id *= *"([^"]+)".*/\1/p' "$TF/terraform.tfvars")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [[ "${1:-}" == "--off" ]]; then
  echo 'rm -f /opt/brain/env/atlas.env' > "$TMP/env.sh"
else
  URI=$(terraform -chdir="$TF" output -raw atlas_memory_uri)
  if [[ -z "$URI" ]]; then
    echo "No Atlas cluster: set atlas_org_id, atlas_client_id and atlas_client_secret in terraform/atlas.auto.tfvars, then apply."
    exit 1
  fi
  ENV_B64=$(printf "AGENT_MEMORY_MONGODB_URI='%s'\n" "$URI" | base64 | tr -d '\n')
  printf 'umask 077; echo %s | base64 -d > /opt/brain/env/atlas.env; chown brain:brain /opt/brain/env/atlas.env\n' "$ENV_B64" > "$TMP/env.sh"
fi
echo 'cd /opt/brain/app && sudo -u brain bash infra/azure/vm/memory-atlas.sh' >> "$TMP/env.sh"

echo "== switching the agents' memory (agent-memory restart, brain rebuild, OpenMetadata, reset: a few minutes)"
az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts @"$TMP/env.sh" \
  --query "value[0].message" -o tsv | sed -E '/^\[(stdout|stderr)\]$/d;/^Enable succeeded/d'
