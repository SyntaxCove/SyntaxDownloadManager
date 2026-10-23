#!/usr/bin/env bash
# Poll GitHub Actions runs for the phase-33 push (ci on main, release on v1.2.0).
# Usage: poll-runs-33.sh <timeout_seconds>
set -u
T=$(sed -n 's/^Token:[[:space:]]*//p' /home/z/my-project/upload/Github.txt | tr -d '[:space:]')
API=https://api.github.com/repos/SyntaxCove/SyntaxDownloadManager/actions
CI=39912730908
REL=39912749534
TIMEOUT=${1:-540}
start=$(date +%s)

fetch() { curl -sS -H "Authorization: Bearer $T" "$API/runs/$1" ; }

while :; do
  ci=$(fetch $CI); rel=$(fetch $REL)
  cis=$(python3 -c "import json,sys;d=json.load(sys.stdin);print(d['status'],d.get('conclusion'))" <<<"$ci")
  rels=$(python3 -c "import json,sys;d=json.load(sys.stdin);print(d['status'],d.get('conclusion'))" <<<"$rel")
  echo "[$(date -u +%H:%M:%S)] ci: $cis | release: $rels"
  case "$cis" in completed*) case "$rels" in completed*) break;; esac;; esac
  now=$(date +%s); (( now - start >= TIMEOUT )) && { echo "TIMEOUT after ${TIMEOUT}s"; exit 2; }
  sleep 60
done

echo "=== FINAL ==="
echo "ci:      $cis"
echo "release: $rels"
[[ "$cis" == *success* && "$rels" == *success* ]]
