#!/usr/bin/env bash
# デスクトップモード開発起動: Vite dev を裏で起動し、Electron を GRAPHY_DEV=1 で起動。
# Electron 側が backend(jar, standalone) を spawn するため、backend jar が必要。
# 古い jar による 404 を避けるため、毎回 最新コードで再ビルドする（UI は Vite が配信するので frontend はスキップ）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[dev-desktop] backend jar を最新コードでビルドします（UIは Vite が配信・テストはスキップ）..."
( cd backend && ${MVN:-mvn} -q -Dfrontend.skip=true -DskipTests clean package )

# 同梱用にステージされた古い jar が backend/target を隠さないよう、dev では除去する。
rm -rf desktop/resources/backend

# このプロジェクトの vite / esbuild だけを対象にしたパターン（他プロジェクトは巻き込まない）。
# 実体 vite は `node .../.bin/vite`、その子 esbuild は argv に "vite" を含まないため、
# 両方を取りこぼさないよう alternation で拾う。
VITE_MATCH="$ROOT/frontend/node_modules/.*(vite|esbuild)"

# npm が spawn する実 vite は cleanup で orphan になりやすく、複数残ると .vite キャッシュを
# 奪い合って "ENOENT .../deps_temp_*/_metadata.json" 競合を起こす。起動前に必ず掃除する。
kill_stale_vite() { pkill -f "$VITE_MATCH" 2>/dev/null || true; }
echo "[dev-desktop] 残存 vite を掃除します ..."
kill_stale_vite

echo "[dev-desktop] starting frontend (Vite) on :5173 ..."
# monitor モードを一時的に有効にし、Vite をスクリプトとは別のプロセスグループで起動する。
# こうすると Electron 終了時に `kill -- -PGID` で npm→vite→esbuild の木をまとめて確実に
# 止められる。個別 kill では npm が子 vite を、vite が子 esbuild を orphan 化して残り、
# ターミナルが終了しない（"stopping vite" 後に残存する）原因になっていた。
set -m
( cd frontend && exec npm run dev ) &
VITE_PGID=$!   # monitor モードでは $! がバックグラウンドジョブのプロセスグループ ID。
set +m

cleanup() {
  echo "[dev-desktop] stopping vite (pgid $VITE_PGID)"
  # プロセスグループごと終了（npm→vite→esbuild をまとめて落とす）。
  kill -TERM -"$VITE_PGID" 2>/dev/null || true
  # 念のため、取りこぼした実体を名前一致で掃除。
  kill_stale_vite
}
trap cleanup EXIT INT TERM

# Vite が応答するまで待つ（固定 sleep だと初回の依存最適化が間に合わず、Electron が
# 空ページを掴んで「メニューだけ・真っ白」になることがある。最大 60s ポーリング）。
DEV_URL="${GRAPHY_DEV_URL:-http://localhost:5173}"
echo "[dev-desktop] Vite ($DEV_URL) の起動を待っています ..."
for i in $(seq 1 120); do
  if curl -fsS -o /dev/null "$DEV_URL" 2>/dev/null; then
    echo "[dev-desktop] Vite 応答を確認（${i}回目）"
    break
  fi
  sleep 0.5
done

echo "[dev-desktop] launching Electron (standalone backend を spawn) ..."
cd desktop && GRAPHY_DEV=1 npm start
