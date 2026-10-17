#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
sleep 1
# VNC only on localhost; noVNC (websockify) on 6080 is reached through Caddy with basic auth
x11vnc -display :99 -forever -shared -nopw -localhost -quiet -rfbport 5900 -xkb -skip_lockkeys &
websockify --web /usr/share/novnc 6080 localhost:5900 &
exec node /app/browser.mjs
