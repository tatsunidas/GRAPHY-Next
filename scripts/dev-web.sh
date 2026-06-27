#!/usr/bin/env bash
# Web モード開発起動: backend(web profile) をバックグラウンドで、frontend(Vite dev) を前面で起動。
# Ctrl-C で両方停止する。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[dev-web] starting backend (web profile) on :8080 ..."
( cd backend && ${MVN:-mvn} -q spring-boot:run -Dspring-boot.run.profiles=web ) &
BACKEND_PID=$!

cleanup() {
  echo "[dev-web] stopping backend ($BACKEND_PID)"
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[dev-web] starting frontend (Vite) on :5173 ..."
echo "[dev-web] ブラウザで http://localhost:5173 を開いてください (mode: web 表示を確認)"
cd frontend && npm run dev
