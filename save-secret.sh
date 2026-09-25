#!/usr/bin/env bash
# Store a secret in a private file, so it never goes into a chat message, a
# command argument, or your shell history.
#
#   ./save-secret.sh GEMINI_API_KEY
#
# The value is typed at a hidden prompt. Command arguments are visible in
# `history` and in `ps` output while the command runs, which is why the value
# is never passed as one.

set -euo pipefail

DIR="${KNOWLEDGE_SECRETS:-$HOME/.config/knowledge}"
FILE="$DIR/secrets.env"
NAME="${1:-}"

if [ -z "$NAME" ]; then
  echo "usage: ./save-secret.sh <NAME>     e.g. ./save-secret.sh GEMINI_API_KEY" >&2
  exit 1
fi
case "$NAME" in
  *[!A-Za-z0-9_]*) echo "name must be letters, digits and underscores only" >&2; exit 1 ;;
esac

mkdir -p "$DIR"
chmod 700 "$DIR"

# Read from the terminal when there is one, so the value is never echoed and
# never becomes part of a pipeline someone could inspect.
if [ -r /dev/tty ] && [ -t 1 ]; then
  printf 'Paste the value for %s (hidden): ' "$NAME" >&2
  IFS= read -rs VALUE < /dev/tty
  printf '\n' >&2
else
  IFS= read -r VALUE      # piped input, for scripting
fi

[ -n "${VALUE:-}" ] || { echo "nothing entered - not saved" >&2; exit 1; }

TMP=$(mktemp "${TMPDIR:-/tmp}/secret.XXXXXX")
chmod 600 "$TMP"
if [ -f "$FILE" ]; then
  grep -v "^${NAME}=" "$FILE" > "$TMP" || true
fi
printf '%s=%s\n' "$NAME" "$VALUE" >> "$TMP"
mv "$TMP" "$FILE"
chmod 600 "$FILE"
unset VALUE

echo "Saved $NAME to $FILE"
ls -l "$FILE" | awk '{print "  permissions:", $1}'
echo "  Push it to Cloudflare with:  wrangler secret bulk \"$FILE\""
