#!/bin/sh
# Modgaze Cloudflare Tunnel (token mode). API 8787 only.
# Usage: cf/tunnel.sh start|stop|restart|status
set -eu
BIN=${BIN:-cloudflared}
TOKEN_FILE=${TOKEN_FILE:-/etc/cloudflared/token}
LOG=${LOG:-/var/log/cloudflared-modgaze.log}
PIDFILE=${PIDFILE:-/run/cloudflared-modgaze.pid}

running() {
  [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null
}

case "${1:-}" in
  start)
    if running; then echo "already running pid=$(cat "$PIDFILE")"; exit 0; fi
    [ -r "$TOKEN_FILE" ] || { echo "missing $TOKEN_FILE" >&2; exit 1; }
    mkdir -p "$(dirname "$LOG")"
    setsid sh -c "while :; do $BIN tunnel run --token-file $TOKEN_FILE >> $LOG 2>&1; sleep 5; done" >/dev/null 2>&1 &
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
    if running; then echo "running pid=$(cat "$PIDFILE")"; else echo stopped; exit 1; fi
    ;;
  *)
    echo "usage: $0 start|stop|restart|status" >&2
    exit 2
    ;;
esac
