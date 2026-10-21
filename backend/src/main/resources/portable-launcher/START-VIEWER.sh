#!/bin/sh
# GRAPHY Portable 2D Viewer launcher (Linux). Run: sh START-VIEWER.sh
cd "$(dirname "$0")" || exit 1
if ! command -v perl >/dev/null 2>&1; then
  echo "perl was not found. perl is required to start the local viewer server."
  exit 1
fi
exec perl "VIEWER/serve.pl" "$PWD"
