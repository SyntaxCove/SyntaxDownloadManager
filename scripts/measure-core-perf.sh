#!/usr/bin/env bash
# Phase 22 one-off baseline probe: measure download-core cold-start latency (spawn -> core.ready)
# and steady-state RSS. Used only to CALIBRATE the perf budgets; the enforced gates live in
# core/crates/download-core/tests/perf.rs and scripts/check-budgets.mjs.
set -euo pipefail
cd "$(dirname "$0")/.."

EXE="core/target/debug/download-core"
DB="$(mktemp -u /tmp/dc-perf-XXXXXX).db"

python3 - "$EXE" "$DB" <<'PY'
import subprocess, sys, time, threading, os, signal

exe, db = sys.argv[1], sys.argv[2]
p = subprocess.Popen([exe], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL, text=True, bufsize=1)
t0 = time.perf_counter()
ready_ms = None

def reader():
    global ready_ms
    for line in p.stdout:
        if '"core.ready"' in line and ready_ms is None:
            ready_ms = (time.perf_counter() - t0) * 1000
            break

th = threading.Thread(target=reader, daemon=True)
th.start()
th.join(timeout=30)

rss_kb = None
with open(f"/proc/{p.pid}/status") as f:
    for line in f:
        if line.startswith("VmRSS:"):
            rss_kb = int(line.split()[1])
            break

# echo round-trip: 100 pings
t1 = time.perf_counter()
for i in range(100):
    p.stdin.write('{"v":1,"id":"p%d","method":"core.ping"}\n' % i)
p.stdin.flush()
seen = 0
for line in p.stdout:
    if '"core.ping"' in line or '"pong"' in line:
        seen += 1
        if seen == 100:
            break
echo_ms = (time.perf_counter() - t1) * 1000

p.terminate()
try:
    p.wait(timeout=5)
except Exception:
    p.kill()
os.remove(db) if os.path.exists(db) else None

print(f"ready_latency_ms={ready_ms:.1f}")
print(f"rss_kb={rss_kb}")
print(f"echo_100_total_ms={echo_ms:.1f}")
print(f"echo_avg_us={echo_ms * 10:.1f}")
PY
