#!/bin/sh
set -eu
export DISPLAY=:99
mkdir -p /data/chrome-profile /data/diagnostics
rm -f /data/chrome-profile/SingletonLock /data/chrome-profile/SingletonCookie /data/chrome-profile/SingletonSocket
Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbport 5900 -listen 0.0.0.0 -nopw >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
CHROMIUM_BIN="${PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH:-/ms-playwright/chromium-1234/chrome-linux64/chrome}"
"$CHROMIUM_BIN" --no-sandbox --user-data-dir=/data/chrome-profile --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 --no-first-run --no-default-browser-check https://chatgpt.com/ >/tmp/chromium.log 2>&1 &
for attempt in $(seq 1 60); do
  node -e "fetch('http://127.0.0.1:9222/json/version').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" && break
  sleep 1
done
exec pnpm --filter seniorstudio-browser-bridge start
