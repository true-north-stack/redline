#!/usr/bin/env bash
# Local Supabase stack for the Redline test suite. Isolated in .redline-stack/ on
# ports 553xx so it never collides with a host project's stack on 543xx.
# Idempotent: re-running resets the DB, restarts the functions server, and
# keeps the secrets (so an already-sourced test env stays valid).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK="$ROOT/.redline-stack"
cd "$ROOT"

if [ ! -d "$STACK" ]; then
  mkdir -p "$STACK"
  (cd "$STACK" && supabase init --force --with-vscode-settings=false --with-intellij-settings=false >/dev/null)
fi

CFG="$STACK/supabase/config.toml"
CFG_BEFORE="$(shasum "$CFG" | cut -d' ' -f1)"
# max_rows is lowered from the default 1000 so the suite exercises paging past the
# PostgREST cap without inserting thousands of rows.
sed -E -i.bak \
  -e 's/^(max_rows *= *)[0-9]+/\1100/' \
  -e 's/([^0-9])54([0-9]{3})([^0-9]|$)/\155\2\3/g' \
  -e 's/^(inspector_port *= *)[0-9]+/\18183/' \
  -e 's/^(project_id *= *).*/\1"redline-stack"/' \
  "$CFG"
rm -f "$CFG.bak"
# Expose the feedback schema through the Data API.
if ! grep -E '^schemas *=' "$CFG" | grep -q '"feedback"'; then
  sed -E -i.bak '/^\[api\]/,/^\[/ s/^(schemas *= *\[.*)\]/\1, "feedback"]/' "$CFG"
  rm -f "$CFG.bak"
fi
grep -E '^schemas *=' "$CFG" | grep -q '"feedback"' || { echo "failed to add feedback to [api] schemas" >&2; exit 1; }
grep -qE '^max_rows *= *100$' "$CFG" || { echo "failed to set max_rows" >&2; exit 1; }
CFG_CHANGED=0
[ "$(shasum "$CFG" | cut -d' ' -f1)" = "$CFG_BEFORE" ] || CFG_CHANGED=1

SB="$STACK/supabase"
rm -rf "$SB/migrations" "$SB/functions"
mkdir -p "$SB/migrations" "$SB/functions"
cp -R "$ROOT"/supabase/migrations/. "$SB/migrations/"
cp -R "$ROOT"/supabase/functions/. "$SB/functions/"

# Stop the functions server first: a restart below needs its container name, and it is
# started again afterwards so functions added since the last run are served.
PID_FILE="$STACK/functions.pid"
if [ -f "$PID_FILE" ]; then
  OLD="$(cat "$PID_FILE")"
  if kill -0 "$OLD" 2>/dev/null; then
    kill -- "-$OLD" 2>/dev/null || kill "$OLD" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

cd "$STACK"
if supabase status >/dev/null 2>&1 && [ "$CFG_CHANGED" = 1 ]; then
  # Config is read at start: restart this stack (and only this one) to apply it
  supabase stop
  supabase start
  supabase db reset
elif supabase status >/dev/null 2>&1; then
  supabase db reset
else
  # A stopped stack keeps its old database, so start alone would skip new migrations
  supabase start
  supabase db reset
fi

# Secrets: generated once, reused after.
FN_ENV="$STACK/fn.env"
if [ ! -f "$FN_ENV" ]; then
  printf 'REDLINE_PURGE_SECRET=%s\nREDLINE_SYNC_SECRET=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > "$FN_ENV"
fi
STATUS_ENV="$(supabase status -o env)"
val() { printf '%s\n' "$STATUS_ENV" | grep -E "^$1=" | head -1 | cut -d= -f2- | tr -d '"'; }
API_URL="$(val API_URL)"
# The functions container sees SUPABASE_URL as an internal host; signed URLs it
# returns must point at the host-reachable API URL.
sed -i.bak '/^REDLINE_PUBLIC_URL=/d' "$FN_ENV" && rm -f "$FN_ENV.bak"
printf 'REDLINE_PUBLIC_URL=%s\n' "$API_URL" >> "$FN_ENV"
PURGE_SECRET="$(grep '^REDLINE_PURGE_SECRET=' "$FN_ENV" | cut -d= -f2-)"
SYNC_SECRET="$(grep '^REDLINE_SYNC_SECRET=' "$FN_ENV" | cut -d= -f2-)"

: > "$STACK/functions.log"
set -m
nohup supabase functions serve --no-verify-jwt --env-file "$FN_ENV" >> "$STACK/functions.log" 2>&1 &
echo $! > "$PID_FILE"
set +m

printf 'waiting for functions'
for _ in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/functions/v1/redline-purge" || true)"
  [ "$code" = "401" ] && break
  printf '.'; sleep 1
done
echo
[ "$code" = "401" ] || { echo "functions server did not come up (last status $code); see $STACK/functions.log" >&2; exit 1; }

cat > "$STACK/test.env" <<ENV
REDLINE_SB_URL=$API_URL
REDLINE_SB_SECRET=$(val SECRET_KEY)
REDLINE_SB_PUBLIC=$(val PUBLISHABLE_KEY)
REDLINE_SB_PURGE_SECRET=$PURGE_SECRET
REDLINE_SB_SYNC_SECRET=$SYNC_SECRET
ENV
echo "wrote $STACK/test.env"
