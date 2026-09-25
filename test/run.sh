#!/usr/bin/env bash
# Run both suites. The UI suite drives a real headless Chrome over the
# DevTools protocol, so it needs the site served somewhere.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-8731}"
node test/engine.test.mjs

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

BASE="http://localhost:$PORT" node test/ui.test.mjs
