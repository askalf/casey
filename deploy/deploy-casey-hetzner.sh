#!/usr/bin/env bash
# Idempotent deploy of casey + arnie on the Hetzner box, reusing the existing
# dario on the askalf network. Safe to re-run (pulls latest, rebuilds, re-ups).
#
# Prereqs (one-time):
#   1. /root/.askalf/.env contains DARIO_API_KEY (already there for the platform).
#   2. Append the casey-console connector token to that env file:
#        echo "CASEY_TUNNEL_TOKEN=<paste from dev box casey-live/.cf-tunnel-token>" >> /root/.askalf/.env
#   3. The dev-box casey tunnel is stopped LAST (after this verifies) — a tunnel's
#      connector should run in one place.
#
# Run:  bash /root/.askalf/src/casey/deploy/deploy-casey-hetzner.sh
set -euo pipefail

ROOT=/root/.askalf
SRC=$ROOT/src
ENVFILE=$ROOT/.env
DATA=$ROOT/casey-data

command -v docker >/dev/null || { echo "docker not found"; exit 1; }
[ -f "$ENVFILE" ] || { echo "missing $ENVFILE"; exit 1; }
grep -q '^DARIO_API_KEY=' "$ENVFILE" || { echo "DARIO_API_KEY not in $ENVFILE"; exit 1; }
grep -q '^CASEY_TUNNEL_TOKEN=' "$ENVFILE" || { echo "CASEY_TUNNEL_TOKEN not in $ENVFILE — add it (see header)"; exit 1; }

mkdir -p "$SRC" "$DATA"
# seed roles.json (email -> role) if absent; extend with your staff + the CF Access policy
[ -f "$DATA/roles.json" ] || echo '{ "hello@askalf.org": "owner" }' > "$DATA/roles.json"

clone_or_pull() { # url dir
  if [ -d "$2/.git" ]; then git -C "$2" pull --ff-only; else git clone "$1" "$2"; fi
}
clone_or_pull https://github.com/askalf/casey "$SRC/casey"
clone_or_pull https://github.com/askalf/arnie "$SRC/arnie"

COMPOSE="$SRC/casey/deploy/docker-compose.hetzner.yml"
docker compose --env-file "$ENVFILE" -f "$COMPOSE" up -d --build

echo
echo "== status =="
docker compose --env-file "$ENVFILE" -f "$COMPOSE" ps
echo
echo "Verify: curl -sI https://casey.askalf.org/  (expect 302 -> cloudflareaccess login)"
echo "Then stop the dev-box stack (stop-stack.bat + the tunnel) so nothing depends on it."
