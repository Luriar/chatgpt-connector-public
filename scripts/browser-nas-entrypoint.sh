#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
SCREEN="${WEBJJONKU_BROWSER_SCREEN:-1440x900x24}"

rm -f "/tmp/.X${DISPLAY#:}-lock" "/tmp/.X11-unix/X${DISPLAY#:}" 2>/dev/null || true

Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
sleep 0.4
fluxbox >/tmp/fluxbox.log 2>&1 &
VNC_PASS_FILE="/browser-profile/.vnc-password"
AUTH_FILE="/tmp/x11vnc.pass"
if [ -r "$VNC_PASS_FILE" ]; then
  VNC_PASS="$(cat "$VNC_PASS_FILE")"
  [ -n "$VNC_PASS" ] || { echo "empty $VNC_PASS_FILE" >&2; exit 1; }
  x11vnc -storepasswd "$VNC_PASS" "$AUTH_FILE" >/dev/null 2>&1
  x11vnc -display "$DISPLAY" -localhost -forever -shared -rfbauth "$AUTH_FILE" -rfbport 5900 -noxdamage >/tmp/x11vnc.log 2>&1 &
else
  echo "unreadable $VNC_PASS_FILE" >&2
  exit 1
fi
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/novnc.log 2>&1 &

# The worker owns a warm persistent browser when keep-open is enabled and
# idle-close is zero. Start a separate Chromium process only for explicit CDP.
mkdir -p /browser-profile /browser-profile/downloads
if [ -n "${WEBJJONKU_BROWSER_CDP_URL:-}" ]; then
  CDP_PORT="${WEBJJONKU_BROWSER_CDP_PORT:-9222}"
  rm -f /browser-profile/SingletonLock /browser-profile/SingletonCookie /browser-profile/SingletonSocket 2>/dev/null || true
  chromium \
    --no-sandbox \
    --password-store=basic \
    --user-data-dir=/browser-profile \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CDP_PORT" \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --window-size=1400,820 \
    about:blank >/tmp/chromium.log 2>&1 &

  i=0
  while [ "$i" -lt 60 ]; do
    if wget -qO- "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then break; fi
    i=$((i+1))
    sleep 0.25
  done
  if ! wget -qO- "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
    echo "Chromium CDP did not become ready" >&2
    tail -100 /tmp/chromium.log >&2 || true
    exit 1
  fi
fi

exec node /app/scripts/browser-worker.js
