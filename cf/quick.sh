#!/bin/sh
# Modgaze Cloudflare quick tunnel (no domain). API 8787 only.
# Usage: cf/quick.sh start|stop|restart|status|url
set -eu
BIN=${BIN:-cloudflared}
TARGET=${TARGET:-http://127.0.0.1:8787}
LOG=${LOG:-/var/log/cloudflared-quick.log}
PIDFILE=${PIDFILE:-/run/cloudflared-quick.pid}

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

url() {
  [ -f "$LOG" ] && grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | tail -1 || true
}

case "${1:-}" in
  start)
    if running; then echo "already running pid=$(cat "$PIDFILE")"; url; exit 0; fi
    mkdir -p "$(dirname "$LOG")"
    setsid sh -c "while :; do $BIN tunnel --url $TARGET --no-autoupdate >> $LOG 2>&1; sleep 5; done" >/dev/null 2>&1 &
    echo $! > "$PIDFILE"
    echo "started pid=$(cat "$PIDFILE")"
    ;;
  stop)
    if running; then
      PGID=$(cat "$PIDFILE")
      kill -TERM -- "-$PGID" 2>/dev/null || kill -TERM "$PGID" 2>/dev/null || true
      rm -f "$PIDFILE"
      echo stopped
    else
      rm -f "$PIDFILE"
      echo "not running"
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    if running; then echo "running pid=$(cat "$PIDFILE")"; url; else echo stopped; exit 1; fi
    ;;
  url)
    url
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|url" >&2
    exit 2
    ;;
esac
