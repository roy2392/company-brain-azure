#!/usr/bin/env bash
# Deploy the repo to the Azure VM that Terraform created, then run the VM bootstrap.
#   ./infra/azure/deploy.sh          # sync code + bootstrap (idempotent)
#   ./infra/azure/deploy.sh --data   # also ship the brain's Atlas data (first deploy): mongodump of the local stack
# Needs: terraform apply done (infra/azure/terraform), ssh access (your IP in ssh_allowed_cidrs), rsync.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TF="$ROOT/infra/azure/terraform"
IP=$(terraform -chdir="$TF" output -raw vm_public_ip)
USER_NAME=$(terraform -chdir="$TF" output -raw admin_username)
TARGET="$USER_NAME@$IP"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30)

echo "== waiting for cloud-init on $IP"
ssh "${SSH_OPTS[@]}" "$TARGET" 'cloud-init status --wait >/dev/null 2>&1; docker version --format "docker {{.Server.Version}}"'

echo "== syncing the repo"
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" \
  --exclude node_modules --exclude .cache --exclude .env --exclude .git --exclude apps/web/dist \
  --exclude 'infra/azure/terraform/.terraform*' --exclude 'infra/azure/terraform/terraform.tfstate*' --exclude 'infra/azure/terraform/*.tfvars' \
  --exclude docs/demo/*.mp4 --exclude docs/demo/*.webm \
  "$ROOT/" "$TARGET:/opt/brain/app/"

if [[ "${1:-}" == "--data" ]]; then
  echo "== shipping the brain's Atlas data (local brain_atlas → VM)"
  TMP=$(mktemp -d)
  docker exec brain_atlas mongodump --archive --gzip --db wisteria_brain > "$TMP/wisteria_brain.archive.gz"
  ls -lh "$TMP/wisteria_brain.archive.gz" | awk '{print "   " $5}'
  scp "${SSH_OPTS[@]}" "$TMP/wisteria_brain.archive.gz" "$TARGET:/opt/brain/data/wisteria_brain.archive.gz"
  rm -rf "$TMP"
fi

echo "== bootstrap (runs detached on the VM; log: /opt/brain/data/bootstrap.log)"
ssh "${SSH_OPTS[@]}" "$TARGET" 'nohup bash /opt/brain/app/infra/azure/vm/bootstrap.sh > /opt/brain/data/bootstrap.log 2>&1 < /dev/null &'
ssh "${SSH_OPTS[@]}" "$TARGET" 'sleep 2; tail -n +1 -f /opt/brain/data/bootstrap.log --pid=$(pgrep -f "bash /opt/brain/app/infra/azure/vm/bootstrap.sh" | head -1)'
