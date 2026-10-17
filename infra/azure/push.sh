#!/usr/bin/env bash
# Ship the repo to the VM through Azure Run Command (management API) instead of SSH, then optionally run a command.
# For networks where SSH to the VM is blocked (e.g. a corporate client routing port 22 through its own egress).
#   ./infra/azure/push.sh                         # sync the code (git-tracked + new, non-ignored files)
#   ./infra/azure/push.sh "docker restart brain_app"
#   ./infra/azure/push.sh --exec "docker logs --tail 50 brain_app"   # only run a command, no sync
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TF="$ROOT/infra/azure/terraform"
RG=$(terraform -chdir="$TF" output -raw resource_group)
VM="vm-${RG#rg-}"
SUB=$(sed -nE 's/^subscription_id *= *"([^"]+)".*/\1/p' "$TF/terraform.tfvars")
run() { az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts @"$1" --query "value[0].message" -o tsv; }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A command runs as the admin user from the repo. It is shipped base64-encoded and run with bash,
# because Run Command executes its script with sh.
remote_cmd() {
  printf 'echo %s | base64 -d > /opt/brain/data/cmd.sh && chown brain:brain /opt/brain/data/cmd.sh && cd /opt/brain/app && sudo -u brain bash /opt/brain/data/cmd.sh\n' \
    "$(printf '%s\n' "$1" | base64 | tr -d '\n')"
}

if [[ "${1:-}" == "--exec" ]]; then
  remote_cmd "$2" > "$TMP/exec.sh"
  run "$TMP/exec.sh"
  exit
fi

cd "$ROOT"
git ls-files -co --exclude-standard | grep -vE '\.(mp4|webm)$' > "$TMP/files"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$TMP/repo.tgz" -T "$TMP/files"
base64 < "$TMP/repo.tgz" | tr -d '\n' > "$TMP/repo.b64"
split -b 150000 "$TMP/repo.b64" "$TMP/part."
echo "== shipping $(wc -l < "$TMP/files" | tr -d ' ') files ($(du -h "$TMP/repo.tgz" | cut -f1)) in $(ls "$TMP"/part.* | wc -l | tr -d ' ') parts"
first=1
for p in "$TMP"/part.*; do
  { [[ $first == 1 ]] && echo "rm -f /opt/brain/data/push.b64"; printf "printf '%%s' '%s' >> /opt/brain/data/push.b64\n" "$(cat "$p")"; } > "$TMP/chunk.sh"
  run "$TMP/chunk.sh" > /dev/null
  first=0
done
cat > "$TMP/apply.sh" <<EOF
set -e
base64 -d /opt/brain/data/push.b64 | tar --warning=no-unknown-keyword -xz -C /opt/brain/app
chown -R brain:brain /opt/brain/app
rm -f /opt/brain/data/push.b64
echo "code synced to /opt/brain/app"
EOF
if [[ -n "${1:-}" ]]; then remote_cmd "$1" >> "$TMP/apply.sh"; fi
run "$TMP/apply.sh"
