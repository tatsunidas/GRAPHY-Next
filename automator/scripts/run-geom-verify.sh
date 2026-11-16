#!/usr/bin/env bash
# ROI・マスク・計測の幾何検証（automator/src/spike/geom*Check.ts の 8 本）を 1 本ずつ走らせ、最後に集計する。
#
#   cd automator && bash scripts/run-geom-verify.sh
#   GEOM_ONLY=Roi,Mask bash scripts/run-geom-verify.sh      一部だけ走らせる（既定は 8 本全部）
#
# 設計:
#   - 失敗しても全部走らせ、最後に表を出す。1 つでも 非 0・失敗・結果 JSON なし・ポートの残りがあれば全体の終了コードは 1。未達は表示のみ。
#   - アプリの検査は並行すると壊れるので、必ず 1 本ずつ。検査ごとに専用ポートとデータ置き場を使う。
#   - 結果: .results/geom-verify/<検査名>.log（標準出力）・<検査名>.json（件数・未達の名前。spike が書く）・summary.txt
#   - `pkill -f`・`pgrep -f` は使わない。子は setsid で別セッションにして PID を控え、残りはセッション ID で探す。
#   - Python 依存は requirements-geom.txt に版を固定。事前チェックで不足を名指しして止まる（環境は黙って書き換えない）。
#   環境変数:
#     GEOM_ONLY            走らせる検査名（カンマ区切り）
#     GRAPHY_TEST_PYTHON   spike が呼ぶ Python（既定: PATH の python3）

AUTOMATOR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$AUTOMATOR" || exit 1
RES="$AUTOMATOR/.results/geom-verify"
REQ="$AUTOMATOR/scripts/requirements-geom.txt"

if [ "$#" -gt 0 ]; then echo "引数は取りません（一部だけ走らせるなら GEOM_ONLY=Roi,Mask）" >&2; exit 2; fi

# 検査名|HTTP ポート|timeout 秒|環境変数（空白区切り）
# SCP = HTTP+1、Vite = HTTP+3（Radiomics は backend だけで GEOM_PORT、SCP は +1）。
SPECS=(
  "Roi|18900|1200|GEOM_IDS=g0_iso,g1_aniso"
  "Mask|18910|1500|GEOM_IDS=g1_aniso"
  "Export|18920|1800|GEOM_IDS=g1_aniso"
  "Calib|18930|1800|"
  "Radiomics|18970|1800|GEOM_PORT=18970"
  "Mpr|18940|3000|GEOM_DRIVER=desktop GEOM_IDS=g0_iso,g1_aniso,g2_oblique,g3b_tilt_iop MPR_SIZES=default,1280x800"
  "XaSeed|18950|1200|"
  "XaIo|18960|1200|"
)
# 呼び出し側の環境から漏れると、検査の中身や負例の向きが変わるもの。
LEAK_VARS=(GEOM_NEG CALIB_NEG GEOM_DUMP GEOM_PARTS GEOM_SIZE_IDS GEOM_IDS GEOM_DRIVER MPR_SIZES CALIB_IDS CALIB_GROUPS XA_IDS GEOM_PORT
           GRAPHY_AUTOMATOR_HTTP_PORT GRAPHY_AUTOMATOR_SCP_PORT GRAPHY_AUTOMATOR_VITE_PORT AUTOMATOR_DATA_DIR)

ALL_NAMES=""
for s in "${SPECS[@]}"; do ALL_NAMES="$ALL_NAMES ${s%%|*}"; done
ONLY=",${GEOM_ONLY:-},"
if [ -n "${GEOM_ONLY:-}" ]; then
  for n in ${GEOM_ONLY//,/ }; do
    case " $ALL_NAMES " in *" $n "*) ;; *) echo "GEOM_ONLY に未知の検査名: ${n}（${ALL_NAMES}）" >&2; exit 2 ;; esac
  done
fi

# ── Python の事前チェック（副作用なし）──
resolve_python() {
  if [ -n "${GRAPHY_TEST_PYTHON:-}" ]; then PY="$GRAPHY_TEST_PYTHON"; else PY="$(command -v python3 || true)"; fi
}
precheck_python() {
  if [ -z "$PY" ]; then echo "Python が見つかりません（python3 が PATH に無い）。" >&2; return 1; fi
  "$PY" -I - "$REQ" <<'PYEOF'
import sys, re
from importlib import metadata
bad = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if not line:
        continue
    name, _, want = line.partition("==")
    try:
        have = metadata.version(name)
    except metadata.PackageNotFoundError:
        bad.append(f"{name}（未導入。要 {want}）")
        continue
    if have != want:
        bad.append(f"{name}（導入済み {have}。要 {want}）")
        continue
    # メタデータだけでなく実際に import できるか（壊れた導入を見逃さない）
    mod = {"scikit-image": "skimage", "Pillow": "PIL", "pydicom": "pydicom"}.get(name, name)
    try:
        __import__(mod)
    except Exception as e:
        bad.append(f"{name}（import 失敗: {e}）")
if bad:
    print("Python 依存が揃っていません。使われる実体: " + sys.executable, file=sys.stderr)
    for b in bad:
        print("  - " + b, file=sys.stderr)
    sys.exit(1)
PYEOF
}
resolve_python
if ! precheck_python; then
  {
    echo "導入するには（上の実体 $PY に入れる。環境は書き換えていません）:"
    echo "  $PY -m pip install -r $REQ"
    echo "別に venv を作るなら:"
    echo "  python3 -m venv <dir> && <dir>/bin/python -m pip install -r $REQ   → GRAPHY_TEST_PYTHON=<dir>/bin/python を付けて再実行"
  } >&2
  exit 2
fi
export GRAPHY_TEST_PYTHON="$PY"
echo "[python] ${PY}（依存は requirements-geom.txt と一致）"

# ── 前提 ──
JAR="$AUTOMATOR/../backend/target/graphy-next-backend.jar"
if [ ! -f "$JAR" ]; then echo "backend の jar が無い: ${JAR}（mvn -Dfrontend.skip=true -DskipTests package）" >&2; exit 2; fi
if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  echo "[警告] DISPLAY が無い。Electron は画面が要る（ヘッドレスなら xvfb-run -a bash $0）。" >&2
fi
echo "[jar] $(ls -l --time-style=long-iso "$JAR" | awk '{print $6, $7}')"

mkdir -p "$RES"
port_listeners() { ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print}' ; }

OVERALL=0
declare -A EXITS
RAN=()

for spec in "${SPECS[@]}"; do
  IFS='|' read -r NAME HTTP TMO ENVS <<<"$spec"
  case "$ONLY" in ",,") ;; *",$NAME,"*) ;; *) continue ;; esac
  RAN+=("$NAME")
  LOG="$RES/$NAME.log"; JSON="$RES/$NAME.json"
  rm -f "$LOG" "$JSON"
  SCP=$((HTTP + 1)); VITE=$((HTTP + 3))
  PORTS="$HTTP $SCP $VITE"

  busy=""
  for p in $PORTS; do
    l="$(port_listeners "$p")"
    [ -n "$l" ] && busy="$busy
  ポート $p: $l"
  done
  if [ -n "$busy" ]; then
    echo "[$NAME] 開始前にポートが塞がっている（孤児プロセスの疑い。PID は ss の出力）。走らせない。$busy" | tee "$LOG" >&2
    EXITS[$NAME]="ポート使用中"; OVERALL=1
    continue
  fi

  DATA="$AUTOMATOR/.results/run-data/$(echo "$NAME" | tr 'A-Z' 'a-z')"
  rm -rf "$DATA"; mkdir -p "$DATA"
  START=$(date +%s)
  echo "[$NAME] 開始 $(date '+%F %T')（HTTP $HTTP / 上限 ${TMO} 秒）"
  # shellcheck disable=SC2086
  setsid env "${LEAK_VARS[@]/#/-u}" \
    GRAPHY_AUTOMATOR_HTTP_PORT="$HTTP" GRAPHY_AUTOMATOR_SCP_PORT="$SCP" GRAPHY_AUTOMATOR_VITE_PORT="$VITE" \
    AUTOMATOR_DATA_DIR="$DATA" $ENVS \
    timeout --kill-after=30 "$TMO" npx tsx "src/spike/geom${NAME}Check.ts" </dev/null >"$LOG" 2>&1 &
  PID=$!
  wait "$PID"; RC=$?
  ELAPSED=$(( $(date +%s) - START ))
  echo "[$NAME] 終了 exit=${RC}（${ELAPSED} 秒）"
  EXITS[$NAME]="$RC"
  [ "$RC" != 0 ] && OVERALL=1
  [ "$RC" = 124 ] && echo "[$NAME] タイムアウト（${TMO} 秒）" >&2

  # 同じセッションに残った自分の子（setsid の下）を探して止める。残っていれば全体を失敗にする。
  LEFT="$(ps -o pid=,args= --sid "$PID" 2>/dev/null)"
  if [ -n "$LEFT" ]; then
    echo "[$NAME] 終了後にセッション $PID に残りがある（全体を失敗にする）:" >&2
    echo "$LEFT" >&2
    # shellcheck disable=SC2046
    kill $(echo "$LEFT" | awk '{print $1}') 2>/dev/null; sleep 3
    # shellcheck disable=SC2046
    kill -9 $(ps -o pid= --sid "$PID" 2>/dev/null) 2>/dev/null
    EXITS[$NAME]="${EXITS[$NAME]}+残り"; OVERALL=1
  fi
  # 別セッション（Vite・Electron の detached）に逃げた残りはポートで見つける。止めずに PID を報告する。
  sleep 2
  for p in $PORTS; do
    l="$(port_listeners "$p")"
    if [ -n "$l" ]; then
      echo "[$NAME] 終了後もポート $p が塞がっている: $l" >&2
      EXITS[$NAME]="${EXITS[$NAME]}+ポート$p"; OVERALL=1
    fi
  done
  [ -f "$JSON" ] || { echo "[$NAME] 結果 JSON が無い（途中で落ちた・タイムアウト）: $JSON" >&2; OVERALL=1; }
done

# ── 全体の表 ──
EXITS_JSON="{"; first=1
for n in "${RAN[@]}"; do [ $first = 1 ] || EXITS_JSON="$EXITS_JSON,"; first=0; EXITS_JSON="$EXITS_JSON\"$n\":\"${EXITS[$n]}\""; done
EXITS_JSON="$EXITS_JSON}"
export GEOM_EXITS="$EXITS_JSON"
{
  echo
  echo "==== 幾何検証の集計（$(date '+%F %T')）===="
  node --input-type=module - "$RES" "${RAN[@]}" <<'JSEOF'
import fs from "node:fs";
import path from "node:path";
const [, , res, ...names] = process.argv;
const exits = JSON.parse(process.env.GEOM_EXITS || "{}");
const rows = [["検査名", "終了コード", "合格", "失敗", "未達", "判定"]];
let bad = 0;
for (const n of names) {
  const f = path.join(res, `${n}.json`);
  let j = null;
  if (fs.existsSync(f)) { try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { j = null; } }
  const rc = exits[n] ?? "?";
  if (!j || j.error !== undefined) {
    rows.push([n, String(rc), "-", "-", "-", j?.error !== undefined ? "例外" : "JSON なし"]);
    bad++;
    continue;
  }
  const ok = String(rc) === "0" && j.failed === 0;
  if (!ok) bad++;
  rows.push([n, String(rc), String(j.passed), String(j.failed), String(j.unreached), ok ? "OK" : "NG"]);
}
const w = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0))));
const pad = (s, n) => s + " ".repeat(n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0));
for (const r of rows) console.log(r.map((c, i) => pad(c, w[i])).join("  "));
for (const n of names) {
  const f = path.join(res, `${n}.json`);
  if (!fs.existsSync(f)) continue;
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const u of j.unreachedNames ?? []) console.log(`  [未達] ${n}: ${u.slice(0, 200)}`);
  for (const u of j.failures ?? []) console.log(`  [失敗] ${n}: ${u}`);
}
process.exit(bad ? 1 : 0);
JSEOF
} 2>&1 | tee "$RES/summary.txt"
[ "${PIPESTATUS[0]}" = 0 ] || OVERALL=1
echo "全体の終了コード: $OVERALL"
exit "$OVERALL"
