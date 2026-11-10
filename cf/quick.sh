#!/bin/sh
# Modgaze Cloudflare quick tunnel (no domain). API 8787 only.
# Usage: cf/quick.sh start|stop|restart|status|url
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
secure() { node "$ROOT/scripts/secure-launch.mjs" "$@"; }
BIN=${BIN:-cloudflared}
TARGET=${TARGET:-http://127.0.0.1:8787}
LOG=${LOG:-/var/log/cloudflared-quick.log}
PIDFILE=${PIDFILE:-/run/cloudflared-quick.pid}

secure check "$LOG" "$PIDFILE"

running() {
  pid=$(secure pid "$PIDFILE") || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

url() {
  secure read "$LOG" | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true
}

case "${1:-}" in
  start)
    if running; then echo "already running pid=$(secure pid "$PIDFILE")"; url; exit 0; fi
    secure launch "$LOG" "$PIDFILE" loop "$BIN" tunnel --url "$TARGET" --no-autoupdate
    echo "started pid=$(secure pid "$PIDFILE")"
    ;;
  stop)
    if running; then
      PGID=$(secure pid "$PIDFILE")
      kill -TERM -- "-$PGID" 2>/dev/null || kill -TERM "$PGID" 2>/dev/null || true
      secure remove "$PIDFILE"
      echo stopped
    else
      secure remove "$PIDFILE"
      echo "not running"
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if running; then echo "running pid=$(secure pid "$PIDFILE")"; url; else echo stopped; exit 1; fi
    ;;
  url)
    url
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|url" >&2
    exit 2
    ;;
esac
