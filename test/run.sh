#!/usr/bin/env bash
# All suites. The browser ones drive a real headless Chrome over the DevTools
# protocol, so the site has to be served somewhere.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-8731}"

echo "── review engine ──";      node test/engine.test.mjs
echo "── token verification ──"; node test/auth.test.mjs
echo "── worker api ──";         node test/api.test.mjs

python3 -m http.server "$PORT" >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
sleep 1

echo "── site ──";    BASE="http://localhost:$PORT" node test/ui.test.mjs
echo "── capture ──"; BASE="http://localhost:$PORT" node test/capture.test.mjs
