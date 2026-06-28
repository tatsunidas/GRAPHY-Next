#!/usr/bin/env bash
# デスクトップモード開発起動: Vite dev を裏で起動し、Electron を GRAPHY_DEV=1 で起動。
# Electron 側が backend(jar, standalone) を spawn するため、backend jar が必要。
# 古い jar による 404 を避けるため、毎回 最新コードで再ビルドする（UI は Vite が配信するので frontend はスキップ）。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[dev-desktop] backend jar を最新コードでビルドします（UIは Vite が配信）..."
( cd backend && ${MVN:-mvn} -q -Dfrontend.skip=true clean package )

echo "[dev-desktop] starting frontend (Vite) on :5173 ..."
( cd frontend && npm run dev ) &
VITE_PID=$!

cleanup() {
  echo "[dev-desktop] stopping vite ($VITE_PID)"
  kill "$VITE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Vite の立ち上がりを少し待つ
sleep 3

echo "[dev-desktop] launching Electron (standalone backend を spawn) ..."
cd desktop && GRAPHY_DEV=1 npm start
