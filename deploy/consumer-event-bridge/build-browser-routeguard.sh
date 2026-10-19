#!/bin/sh
# Optional NAS browser-worker crash fix, separate from Connector/research services.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
BASE=${1:?Supply a compatible browser image}
DEST=${2:-chatgpt-connector-browser:event-bridge}
case "$BASE:$DEST" in *[!a-zA-Z0-9._:/-]*) echo invalid-image-reference >&2;exit 2;;esac
TEMP=$(mktemp -d);trap 'rm -rf "$TEMP"' EXIT HUP INT TERM
cp "$ROOT/apps/consumer-event-bridge/browser-worker-overlay/browser-worker.js" "$TEMP/browser-worker.js"
cp "$ROOT/scripts/browser-route-guard.mjs" "$TEMP/browser-route-guard.mjs"
cp "$ROOT/scripts/browser-url-policy.mjs" "$TEMP/browser-url-policy.mjs"
cp "$ROOT/scripts/chatgpt-event-action.mjs" "$TEMP/chatgpt-event-action.mjs"
cp "$ROOT/scripts/browser-network-diagnostics.mjs" "$TEMP/browser-network-diagnostics.mjs"
cat > "$TEMP/Dockerfile" <<DOCKER
FROM $BASE
COPY browser-worker.js /app/scripts/browser-worker.js
COPY browser-route-guard.mjs /app/scripts/browser-route-guard.mjs
COPY browser-url-policy.mjs /app/scripts/browser-url-policy.mjs
COPY chatgpt-event-action.mjs /app/scripts/chatgpt-event-action.mjs
COPY browser-network-diagnostics.mjs /app/scripts/browser-network-diagnostics.mjs
DOCKER
docker build --pull=false --network=none -t "$DEST" "$TEMP"
