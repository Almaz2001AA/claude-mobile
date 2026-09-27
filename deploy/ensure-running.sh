#!/bin/sh
# Starts tailscaled (userspace, no root) and claude-mobile if they are not running.
# Idempotent: run it from cron at @reboot and every few minutes as a watchdog.
set -u

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-/usr/bin/node}
TS_DIR="$HOME/.local/share/tailscale"
TS_SOCK="$TS_DIR/tailscaled.sock"
LOG_DIR="$HOME/.local/state/claude-mobile"
ENV_FILE="$HOME/.config/claude-mobile/env"

export PATH="$HOME/.local/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"
mkdir -p "$TS_DIR" "$LOG_DIR"

if ! pgrep -u "$(id -u)" -f "^[^ ]*tailscaled --tun=userspace-networking" >/dev/null; then
  setsid nohup tailscaled --tun=userspace-networking --statedir="$TS_DIR" --socket="$TS_SOCK" --port=0 \
    >>"$LOG_DIR/tailscaled.log" 2>&1 </dev/null &
fi

if ! pgrep -u "$(id -u)" -f "^$NODE $APP_DIR/bin/claude-mobile.js serve" >/dev/null; then
  if [ -f "$ENV_FILE" ]; then
    set -a
    . "$ENV_FILE"
    set +a
  fi
  setsid nohup "$NODE" "$APP_DIR/bin/claude-mobile.js" serve >>"$LOG_DIR/claude-mobile.log" 2>&1 </dev/null &
fi
