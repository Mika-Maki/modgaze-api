#!/bin/sh
# Modgaze Cloudflare Tunnel (token mode). API 8787 only.
# Usage: cf/tunnel.sh start|stop|restart|status
set -eu
umask 077
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
secure() { node "$ROOT/scripts/secure-launch.mjs" "$@"; }
BIN=${BIN:-cloudflared}
TOKEN_FILE=${TOKEN_FILE:-/etc/cloudflared/token}
LOG=${LOG:-/var/log/cloudflared-modgaze.log}
PIDFILE=${PIDFILE:-/run/cloudflared-modgaze.pid}

secure check "$LOG" "$PIDFILE"

running() {
  pid=$(secure pid "$PIDFILE") || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

case "${1:-}" in
  start)
    if running; then echo "already running pid=$(secure pid "$PIDFILE")"; exit 0; fi
    [ -r "$TOKEN_FILE" ] || { echo "missing $TOKEN_FILE" >&2; exit 1; }
    secure launch "$LOG" "$PIDFILE" loop "$BIN" tunnel run --token-file "$TOKEN_FILE"
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
    if running; then echo "running pid=$(secure pid "$PIDFILE")"; else echo stopped; exit 1; fi
    ;;
  *)
    echo "usage: $0 start|stop|restart|status" >&2
    exit 2
    ;;
esac
