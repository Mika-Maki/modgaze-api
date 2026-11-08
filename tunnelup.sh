#!/usr/bin/env bash
# tunnelup.sh — 一键启动 Modgaze + Cloudflare named tunnel（token 模式）
# 用法: ./tunnelup.sh start|stop|restart|status|url
# 可选环境变量:
#   MODGAZE_CONFIG   指定配置，默认 config/local.json
#   TUNNEL_TOKEN_FILE 默认 /etc/cloudflared/token
#   TUNNEL_HOST      公网域名，例如 api.example.com
#   TUNNEL_HOST_FILE 域名文件；默认优先 cf/tunnel.host.private（不提交）
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
RUN="$ROOT/run"
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-/etc/cloudflared/token}"
MODGAZE_LOG="$RUN/modgaze-tunnelup.log"
TUNNEL_LOG="$RUN/cloudflared-tunnelup.log"
MODGAZE_PID="$RUN/modgaze-tunnelup.pid"
TUNNEL_PID="$RUN/cloudflared-tunnelup.pid"
HOST_FILE="${TUNNEL_HOST_FILE:-$ROOT/cf/tunnel.host.private}"
if [ -z "${TUNNEL_HOST_FILE:-}" ] && [ ! -f "$HOST_FILE" ]; then
  HOST_FILE="$ROOT/cf/tunnel.host"
fi
mkdir -p "$RUN"

host() {
  if [ -n "${TUNNEL_HOST:-}" ]; then printf '%s\n' "$TUNNEL_HOST"; return; fi
  [ -f "$HOST_FILE" ] && head -n1 "$HOST_FILE" || true
}
health() { curl -fsS -m 2 http://127.0.0.1:8787/healthz >/dev/null 2>&1; }
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

pick_config() {
  if [ -n "${MODGAZE_CONFIG:-}" ]; then printf '%s\n' "$MODGAZE_CONFIG"; return; fi
  if [ -f "$ROOT/config/local.json" ]; then printf '%s\n' "$ROOT/config/local.json"; return; fi
  printf '%s\n' "$ROOT/config/local.json"
}

start_modgaze() {
  if health; then echo "modgaze: already up"; return 0; fi
  local cfg; cfg=$(pick_config)
  [ -f "$cfg" ] || { echo "modgaze: config not found: $cfg" >&2; return 1; }
  setsid node "$ROOT/src/server.mjs" --config "$cfg" >>"$MODGAZE_LOG" 2>&1 &
  echo $! >"$MODGAZE_PID"
  local i
  for i in $(seq 1 80); do
    if health; then echo "modgaze: up (config=$cfg)"; return 0; fi
    sleep 0.25
  done
  echo "modgaze: failed to start; see $MODGAZE_LOG" >&2
  tail -n 5 "$MODGAZE_LOG" >&2 2>/dev/null || true
  return 1
}

start_tunnel() {
  if alive "$TUNNEL_PID"; then echo "tunnel: already running pid=$(cat "$TUNNEL_PID")"; return 0; fi
  [ -r "$TOKEN_FILE" ] || { echo "tunnel: missing token $TOKEN_FILE" >&2; return 1; }
  if ! grep -q 'argotunnel' /etc/hosts 2>/dev/null; then
    echo "warn: /etc/hosts 没有 argotunnel edge 覆盖，Clash fake-ip 可能让隧道注册失败" >&2
  fi
  local start_line=0
  [ -f "$TUNNEL_LOG" ] && start_line=$(wc -l <"$TUNNEL_LOG")
  setsid bash -c "while :; do cloudflared tunnel run --token-file '$TOKEN_FILE' >>'$TUNNEL_LOG' 2>&1; sleep 5; done" >/dev/null 2>&1 &
  echo $! >"$TUNNEL_PID"
  local i
  for i in $(seq 1 120); do
    if tail -n +"$((start_line + 1))" "$TUNNEL_LOG" 2>/dev/null | grep -q 'Registered tunnel connection'; then
      echo "tunnel: registered pid=$(cat "$TUNNEL_PID")"
      return 0
    fi
    sleep 0.25
  done
  echo "tunnel: 未在 30 秒内注册；查看 $TUNNEL_LOG" >&2
  return 1
}

stop_one() {
  local pidfile=$1 name=$2
  if alive "$pidfile"; then
    local pgid; pgid=$(cat "$pidfile")
    kill -TERM -- "-$pgid" 2>/dev/null || kill -TERM "$pgid" 2>/dev/null || true
    rm -f "$pidfile"
    echo "$name: stopped"
  else
    rm -f "$pidfile"
    echo "$name: not running"
  fi
}

status() {
  if health; then echo "modgaze: up"; else echo "modgaze: down"; fi
  if alive "$TUNNEL_PID"; then echo "tunnel: running pid=$(cat "$TUNNEL_PID")"; else echo "tunnel: down"; fi
  local h; h=$(host)
  [ -n "$h" ] && echo "url: https://$h"
  tail -n 3 "$TUNNEL_LOG" 2>/dev/null | sed 's/^/  /' || true
}

case "${1:-}" in
  start)
    start_modgaze || exit 1
    start_tunnel || exit 1
    status
    ;;
  stop)
    stop_one "$TUNNEL_PID" tunnel
    stop_one "$MODGAZE_PID" modgaze
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    status
    ;;
  url)
    h=$(host)
    [ -n "$h" ] || { echo "TUNNEL_HOST 未设置，可写入 cf/tunnel.host.private" >&2; exit 1; }
    echo "https://$h"
    ;;
  *)
    echo "usage: $0 start|stop|restart|status|url" >&2
    exit 2
    ;;
esac
