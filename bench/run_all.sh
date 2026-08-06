#!/usr/bin/env bash
# GRAPHY-Next Benchmark Phantom (GNBP-1)
# Copyright (C) 2026 Visionary Imaging Services, Inc.
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Run the full GNBP-1 benchmark against a pinned build and write every result
# under results/.
#
# The build identity is captured first and embedded in every result file. A
# measurement that cannot be attributed to a specific commit and binary is
# worthless — and the shared working copy at ~/graphy-workspace is rebuilt by
# other sessions without warning, which has already corrupted one run
# (see ENVIRONMENT.md).
#
# Usage:
#   ./run_all.sh                 # accuracy + performance, 5 runs per size
#   RUNS=3 ./run_all.sh          # fewer repetitions
#   SIZES="64 256" ./run_all.sh  # subset of sizes

set -euo pipefail

cd "$(dirname "$0")"

BENCH_DIR="$PWD"
WORKTREE="${WORKTREE:-$BENCH_DIR/.build/gn}"
JAR="$WORKTREE/backend/target/graphy-next-backend.jar"
URL="${URL:-http://localhost:8099}"
RUNS="${RUNS:-5}"
SIZES="${SIZES:-64 128 256 512}"
export DISPLAY="${DISPLAY:-:1}"

mkdir -p results

# --- build identity ---------------------------------------------------------
if [ ! -f "$JAR" ]; then
  echo "jar not found: $JAR" >&2
  echo "build it first:  cd $WORKTREE/backend && mvn -q clean package -DskipTests" >&2
  exit 1
fi

COMMIT=$(git -C "$WORKTREE" rev-parse HEAD)
DIRTY=$(git -C "$WORKTREE" status --porcelain | head -c 1)
JAR_MD5=$(md5sum "$JAR" | awk '{print $1}')
APP_VERSION=$(curl -sf -m 10 "$URL/api/status" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])' 2>/dev/null || echo "unknown")

if [ -n "$DIRTY" ]; then
  echo "WARNING: the benchmark worktree has uncommitted changes; results will not be attributable" >&2
fi

cat > results/build_info.json <<EOF
{
  "commit": "$COMMIT",
  "worktree_clean": $([ -z "$DIRTY" ] && echo true || echo false),
  "jar": "$JAR",
  "jar_md5": "$JAR_MD5",
  "app_version": "$APP_VERSION",
  "url": "$URL"
}
EOF

echo "=== build ==="
cat results/build_info.json
echo

# --- accuracy ---------------------------------------------------------------
# Remove the previous file first. A failed run that leaves an old result in
# place reads as a success; that happened once and nearly went into the log.
echo "=== accuracy (GNBP-1A) ==="
rm -f results/accuracy.json
node measure_accuracy.mjs --url "$URL" --out results/accuracy.json > /dev/null
python3 - <<'PY'
import json
d = json.load(open("results/accuracy.json"))
h = d["hu_accuracy"]
c = d["coordinate_mapping"]
print(f"  HU targets scored : {h['n_scored']}")
print(f"  max |error|       : {h['max_abs_error_hu']} HU")
print(f"  wedge width       : {c['measured_width_mm']} mm (expected {c['expected_width_mm']})")
PY
echo

# --- performance ------------------------------------------------------------
for n in $SIZES; do
  echo "=== performance (GNBP-1B_$n, $RUNS runs) ==="
  out="results/perf_web_${n}.json"
  rm -f "$out"
  node measure.mjs --mode web --url "$URL" --series "GNBP-1B_$n" \
    --runs "$RUNS" --headed --label "GNBP-1B_$n" --slices "$n" --out "$out" > /dev/null
  python3 - "$out" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
s = d["summary"]
r = d.get("webgl_renderer", {})
print(f"  webgl            : {r.get('renderer')}")
def line(label, key, scale=1.0, unit=""):
    v = s.get(key)
    if not v:
        return
    print(f"  {label:<17}: median {v['median']/scale:.1f}{unit}  (min {v['min']/scale:.1f} / max {v['max']/scale:.1f}, n={v['n']})")
line("first image", "time_to_first_image_ms", 1, " ms")
line("viewer first image", "time_to_viewer_first_image_ms", 1, " ms")
line("slice latency", "slice_render_latency_ms", 1, " ms")
line("within 1 frame", "slice_latency_within_one_frame_fraction", 0.01, "%")
line("cine images/s", "cine_images_per_second", 1, "")
line("peak JS heap", "peak_js_heap_bytes", 1048576, " MiB")
PY
  echo
done

echo "all results written to $BENCH_DIR/results/"
