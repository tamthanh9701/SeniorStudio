#!/bin/sh
set -eu
export DISPLAY=:99
mkdir -p /data/chrome-profile /data/diagnostics
Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp &
fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc -display :99 -forever -shared -rfbport 5900 -listen 0.0.0.0 -nopw >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
exec pnpm --filter seniorstudio-browser-bridge start
