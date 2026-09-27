#!/bin/sh
# Starts tailscaled (userspace, no root) and claude-mobile if they are not running.
# Idempotent: run it from cron at @reboot and every few minutes as a watchdog.
set -u

APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=${NODE:-$(command -v node 2>/dev/null || echo /usr/local/bin/node)}
TS_DIR="$HOME/.local/share/tailscale"
TS_SOCK="$TS_DIR/tailscaled.sock"
LOG_DIR="$HOME/.local/state/claude-mobile"
ENV_FILE="$HOME/.config/claude-mobile/env"
SCRIPT_LOCK="$LOG_DIR/ensure-running.lock"
APP_LOCK="$LOG_DIR/claude-mobile.lock"
MAX_LOG_BYTES=5242880 # 5 MiB

export PATH="$HOME/.local/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"
mkdir -p "$TS_DIR" "$LOG_DIR"

# Non-blocking: if a previous invocation of this script is still mid-flight (its checks and
# launches below aren't atomic), just exit rather than race it or pile up. The cron watchdog
# will try again in a few minutes either way.
exec 8>"$SCRIPT_LOCK"
flock -n 8 || exit 0

# Moves $1 to $1.1 once it grows past MAX_LOG_BYTES, so a cron watchdog that runs forever
# never lets these grow unbounded. Deliberately simple: one backup generation, no compression.
rotate_log() {
  log="$1"
  [ -f "$log" ] || return 0
  size=$(wc -c <"$log" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ] 2>/dev/null; then
    mv -f "$log" "$log.1"
  fi
}

if ! pgrep -u "$(id -u)" -f "^[^ ]*tailscaled --tun=userspace-networking" >/dev/null; then
  rotate_log "$LOG_DIR/tailscaled.log"
  setsid nohup tailscaled --tun=userspace-networking --statedir="$TS_DIR" --socket="$TS_SOCK" --port=0 \
    >>"$LOG_DIR/tailscaled.log" 2>&1 </dev/null &
fi

# Exported (allexport) so CLAUDE_MOBILE_LISTEN, CLAUDE_MOBILE_ORIGIN, etc. reach the node
# process started below, including across the setsid/sh -c hop.
if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

rotate_log "$LOG_DIR/claude-mobile.log"

# Matches by this installation's app path, never the node binary path: NODE can drift across
# nvm upgrades between cron ticks, and a pattern anchored on the exact old node path would
# then stop matching an already-running process and start a redundant (port-clashing) second
# one. This also recognizes an instance started before this restart-loop mechanism existed.
APP_PATTERN=$(printf '%s' "$APP_DIR" | sed 's/[.[\^$*]/\\&/g')
if ! pgrep -u "$(id -u)" -f "$APP_PATTERN/bin/claude-mobile\.js[[:space:]]+serve" >/dev/null; then
  # APP_LOCK is additionally held by the loop below for as long as it (and the node process it
  # supervises) is alive, so two cron ticks landing at nearly the same moment can't both pass
  # the pgrep check above and both start a loop. If the lock is already held, this exits
  # immediately without touching anything.
  export APP_LOCK NODE APP_DIR LOG_DIR
  setsid sh -c '
    exec 9>"$APP_LOCK"
    flock -n 9 || exit 0
    # Restart loop: a crash (or a normal `serve` exit) is back up within ~2s instead of needing
    # the next cron tick (up to 5 minutes).
    while :; do
      "$NODE" "$APP_DIR/bin/claude-mobile.js" serve
      sleep 2
    done
  ' >>"$LOG_DIR/claude-mobile.log" 2>&1 </dev/null &
fi
