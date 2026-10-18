#!/usr/bin/env bash
# The quarter time-lapse on the Azure VM: stream Era's latest quarter into Atlas (wisteria_live) one simulated day per
# tick and watch OpenMetadata update (pipeline runs, row counts, freshness, sample data, feed posts). Run Command only.
#   ./infra/azure/demo/timelapse.sh start [--reset] [--interval 3] [--step-days 1]   # runs detached on the VM
#   ./infra/azure/demo/timelapse.sh start --reset --prepare                            # reset only: the clean starting state
#   ./infra/azure/demo/timelapse.sh follow                                           # print progress until it ends
#   ./infra/azure/demo/timelapse.sh status | stop
# Needs the Era tokens on the VM once: ./infra/azure/era-to-vm.sh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
TF="$ROOT/infra/azure/terraform"
RG=$(terraform -chdir="$TF" output -raw resource_group)
VM="vm-${RG#rg-}"
SUB=$(sed -nE 's/^subscription_id *= *"([^"]+)".*/\1/p' "$TF/terraform.tfvars")
run() { az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts "$1" --query "value[0].message" -o tsv | sed -E '/^\[(stdout|stderr)\]$/d;/^Enable succeeded/d;/^$/d'; }
LOG=/tmp/timelapse.log
cmd=${1:-status}; shift || true

case "$cmd" in
  start)
    ARGS=$(printf ' %q' "$@")
    run "docker exec brain_app pkill -f scripts/timelapse.ts >/dev/null 2>&1; test -f /opt/brain/env/era.env || { echo 'no /opt/brain/env/era.env: run infra/azure/era-to-vm.sh'; exit 1; }; docker exec -d --env-file /opt/brain/env/era.env -w /app brain_app sh -c 'npx tsx packages/brain/scripts/timelapse.ts$ARGS > $LOG 2>&1'; sleep 12; docker exec brain_app tail -4 $LOG"
    ;;
  follow)
    while :; do
      out=$(run "docker exec brain_app tail -3 $LOG; docker exec brain_app pgrep -f scripts/timelapse.ts >/dev/null && echo __running || echo __done")
      grep -v '^__' <<<"$out" | tail -3
      grep -q '^__done' <<<"$out" && break
      sleep 8
    done
    ;;
  status) run "docker exec brain_app tail -5 $LOG; docker exec brain_app pgrep -f scripts/timelapse.ts >/dev/null && echo running || echo 'not running'" ;;
  stop) run "docker exec brain_app pkill -f scripts/timelapse.ts && echo stopped || echo 'not running'" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
