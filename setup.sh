#!/usr/bin/env bash
# One-shot setup for the capture backend.
#
# Automates everything that can be automated. Two things cannot be, because
# they need your browser and your credentials:
#   - signing in to Cloudflare       (wrangler login)
#   - creating the Google client ID  (console.cloud.google.com)
#   - putting in your Gemini key     (prompted, never echoed or logged)
#
# Safe to re-run: it reuses what already exists rather than duplicating it.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_DIR="${KNOWLEDGE_SECRETS:-$HOME/.config/knowledge}"
SECRETS_FILE="$SECRETS_DIR/secrets.env"
TOML="$REPO/worker/wrangler.toml"
CONFIG="$REPO/config.js"
DB_NAME="knowledge"

# Read a value from the private secrets file without ever echoing it.
from_secrets() {
  [ -f "$SECRETS_FILE" ] || return 1
  local line
  line=$(grep -m1 "^$1=" "$SECRETS_FILE" 2>/dev/null) || return 1
  printf '%s' "${line#*=}"
}

bold()  { printf '\033[1m%s\033[0m\n' "$1"; }
step()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
warn()  { printf '\033[33m    %s\033[0m\n' "$1"; }
fail()  { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

# Replace a value in a config file without disturbing anything else.
patch() {  # patch <file> <sed-expression> <description>
  python3 - "$1" "$2" "$3" <<'PY'
import pathlib, re, sys
path, pattern, replacement = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
text = path.read_text()
# re.M matters: the toml patterns anchor with ^ and would otherwise only ever
# match the very first line of the file.
new, count = re.subn(pattern, replacement.replace('\\', '\\\\'), text, count=1, flags=re.M)
if not count:
    sys.exit(f"setup: could not find {sys.argv[3][:40]!r} in {path.name} - edit it by hand")
path.write_text(new)
PY
}

# ---------------------------------------------------------------- prereqs --
step "Checking prerequisites"
command -v wrangler >/dev/null || fail "wrangler is not installed. Run: npm install -g wrangler"
echo "    wrangler $(wrangler --version 2>/dev/null | head -1)"

# `wrangler whoami` exits 0 whether or not you are signed in, so the exit
# code proves nothing and the output has to be read instead.
WHOAMI=$(wrangler whoami 2>&1 || true)
if echo "$WHOAMI" | grep -qi "not authenticated"; then
  warn "Not signed in to Cloudflare."
  echo
  bold "    Run this in your own terminal — it opens a browser — then re-run ./setup.sh:"
  echo "        wrangler login"
  echo
  echo "    (It cannot be done from here: the browser hand-off needs a real terminal.)"
  exit 1
fi
echo "    Cloudflare: $(echo "$WHOAMI" | grep -oE '[^ ]+@[^ ]+' | head -1 || echo 'signed in')"

# --------------------------------------------------------------- database --
step "Database"
if wrangler d1 list --json 2>/dev/null | grep -q "\"name\": *\"$DB_NAME\""; then
  echo "    '$DB_NAME' already exists — reusing it."
else
  echo "    Creating '$DB_NAME'…"
  wrangler d1 create "$DB_NAME" >/dev/null
fi

DB_ID=$(wrangler d1 list --json 2>/dev/null | python3 -c "
import json,sys
for d in json.load(sys.stdin):
    if d.get('name') == '$DB_NAME':
        print(d.get('uuid') or d.get('database_id') or ''); break
")
[ -n "$DB_ID" ] || fail "could not read the database id from 'wrangler d1 list'"
echo "    database_id: $DB_ID"

patch "$TOML" '^database_id\s*=\s*".*"' "database_id = \"$DB_ID\""
echo "    wrangler.toml updated."

step "Schema"
wrangler d1 execute "$DB_NAME" --remote --file="$REPO/worker/schema.sql" >/dev/null
echo "    Tables created (re-running this is harmless)."

# -------------------------------------------------------------- allowlist --
step "Allowlist"
DEFAULT_EMAIL=$(git config user.email 2>/dev/null || echo "")
read -r -p "    Your Google account email [${DEFAULT_EMAIL}]: " EMAIL
EMAIL="${EMAIL:-$DEFAULT_EMAIL}"
[ -n "$EMAIL" ] || fail "an email is required — nobody can sign in until one is listed"

# ${VAR,,} is bash 4; macOS ships 3.2.
EMAIL_LC=$(printf '%s' "$EMAIL" | tr '[:upper:]' '[:lower:]')
wrangler d1 execute "$DB_NAME" --remote --command \
  "INSERT INTO user (email, role) VALUES ('$EMAIL_LC', 'owner')
   ON CONFLICT (email) DO UPDATE SET status='allowed', role='owner'" >/dev/null
echo "    $EMAIL_LC is on the allowlist as owner."

# -------------------------------------------------------------- client id --
step "Google sign-in"
CURRENT_ID=$(grep -oE '[A-Za-z0-9._-]+\.apps\.googleusercontent\.com' "$CONFIG" | head -1 || true)
if [ -n "$CURRENT_ID" ] && [ "${CURRENT_ID%%.*}" != "REPLACE_ME" ]; then
  echo "    Already configured: $CURRENT_ID"
else
  echo "    Create an OAuth client ID at https://console.cloud.google.com/apis/credentials"
  echo "      type: Web application"
  echo "      authorised JavaScript origins:"
  echo "        https://phthaocse.github.io"
  echo "        http://localhost:8731"
  echo
  if CLIENT_ID=$(from_secrets GOOGLE_CLIENT_ID) && [ -n "$CLIENT_ID" ]; then
    echo "    Using GOOGLE_CLIENT_ID from $SECRETS_FILE"
  else
    read -r -p "    Paste the client ID: " CLIENT_ID
  fi
  [ -n "$CLIENT_ID" ] || fail "the client ID is required"
  case "$CLIENT_ID" in
    *.apps.googleusercontent.com) ;;
    *) fail "that does not look like a client ID (expected …apps.googleusercontent.com)" ;;
  esac
  patch "$CONFIG" "googleClientId: '[^']*'" "googleClientId: '$CLIENT_ID'"
  patch "$TOML"  '^GOOGLE_CLIENT_ID\s*=\s*".*"' "GOOGLE_CLIENT_ID = \"$CLIENT_ID\""
  echo "    Saved to config.js and wrangler.toml."
fi

# ----------------------------------------------------------------- secret --
step "Gemini key"
if wrangler secret list --name knowledge-api 2>/dev/null | grep -q GEMINI_API_KEY; then
  echo "    Already set (its value cannot be read back, by design)."
elif [ -f "$SECRETS_FILE" ] && grep -q '^GEMINI_API_KEY=' "$SECRETS_FILE"; then
  echo "    Uploading from $SECRETS_FILE …"
  # `secret bulk` takes a KEY=VALUE file, so the key is never an argument and
  # never reaches the shell history or a process listing.
  ( cd "$REPO/worker" && wrangler secret bulk "$SECRETS_FILE" >/dev/null )
  echo "    Uploaded. Cloudflare stores it encrypted; it cannot be read back."
else
  warn "No key found in $SECRETS_FILE."
  echo
  bold "    Save it first, then re-run ./setup.sh:"
  echo "        ./save-secret.sh GEMINI_API_KEY"
  echo
  echo "    (Hidden prompt, written to a mode-600 file. Never paste a key into a chat.)"
  exit 1
fi

# ----------------------------------------------------------------- deploy --
step "Deploying the Worker"
DEPLOY_OUT=$(cd "$REPO/worker" && wrangler deploy 2>&1)
echo "$DEPLOY_OUT" | grep -E "Uploaded|Deployed|workers\.dev" | sed 's/^/    /' || true

WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
if [ -n "$WORKER_URL" ]; then
  patch "$CONFIG" "apiBase: '[^']*'" "apiBase: '$WORKER_URL'"
  echo "    config.js now points at $WORKER_URL"
else
  warn "Could not read the Worker URL from the deploy output."
  warn "Set 'apiBase' in config.js by hand."
fi

# ------------------------------------------------------------------- done --
step "Done"
cat <<DONE
    What is left:

      1. Commit and publish the site so it uses the new settings:
             git add config.js worker/wrangler.toml
             git commit -m "Point the site at my Worker"
             git push origin main

      2. Open the site, go to Capture, and sign in.

      3. Check the lock: sign in with a DIFFERENT Google account. You should be
         refused with "this account is not on the allowlist". If you are let in,
         the client ID in config.js does not match the one in wrangler.toml.

    Allowlist:
      add      wrangler d1 execute $DB_NAME --remote --command "INSERT INTO user (email) VALUES ('x@y.com')"
      revoke   wrangler d1 execute $DB_NAME --remote --command "UPDATE user SET status='revoked' WHERE email='x@y.com'"
      list     wrangler d1 execute $DB_NAME --remote --command "SELECT email, role, status, last_seen_at FROM user"

    Backup:
      wrangler d1 export $DB_NAME --remote --output=knowledge-\$(date +%F).sql
DONE
