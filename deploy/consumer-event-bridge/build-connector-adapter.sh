#!/bin/sh
# Reproducible overlay: preserve the exact base Connector release source,
# add only the opt-in event-bridge registration, and build a tiny derived image.
# No production restart, Compose update, API calls, or model invocation.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
BASE=${1:?Supply a compatible Connector image}
TARGET=${2:-chatgpt-connector:event-bridge}
CHECK=${3:-}
case "$BASE:$TARGET" in *[!a-zA-Z0-9._:/-]*) echo 'Unsafe Docker image reference' >&2;exit 3;;esac
TMP=$(mktemp -d)
CID=''
cleanup(){ if [ -n "$CID" ];then docker rm "$CID" >/dev/null 2>&1 || :;fi;rm -rf "$TMP";}
trap cleanup EXIT HUP INT TERM
CID=$(docker create "$BASE" /bin/true)
docker cp "$CID:/app/src/index.js" "$TMP/index.js"
cp "$ROOT/src/tools/consumer-event-bridge.js" "$TMP/consumer-event-bridge.js"
node - "$TMP/index.js" <<'NODE'
const fs=require('fs'),p=process.argv[2];let x=fs.readFileSync(p,'utf8');
const anchor='import { registerImageDeliveryUi } from "./ui/image-delivery.js";';
const call='  registerImageDeliveryUi(server);';
if(!x.includes(anchor)||!x.includes(call)||x.includes('registerConsumerEventBridgeTools'))throw Error('base Connector does not match single-patch prereqs');
x=x.replace(anchor,anchor+'\nimport { registerConsumerEventBridgeTools } from "./tools/consumer-event-bridge.js";');
x=x.replace(call,call+'\n  registerConsumerEventBridgeTools(reg,server);');
fs.writeFileSync(p,x);console.log('Patched base release registration without altering other tools');
NODE
node --check "$TMP/index.js"
node --check "$TMP/consumer-event-bridge.js"
if [ "$CHECK" = '--check' ];then echo 'CANARY_PATCH_CHECK_OK';exit 0;fi
cat > "$TMP/Dockerfile" <<DOCKER
FROM $BASE
COPY index.js /app/src/index.js
COPY consumer-event-bridge.js /app/src/tools/consumer-event-bridge.js
DOCKER
docker build --pull=false --network=none -t "$TARGET" "$TMP"
echo "DERIVED_IMAGE_READY $TARGET"
