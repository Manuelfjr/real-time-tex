#!/usr/bin/env bash
# Roda o LaTeX Live "para sempre" numa máquina que nunca desliga: reinicia
# o servidor e o túnel sozinho se algum dos dois cair, e grava o link atual
# em tunnel-url.txt (pra você conferir sem precisar entrar na sessão).
#
# Pensado para rodar dentro de tmux/screen, assim sobrevive a você
# desconectar do SSH:
#
#   tmux new -s latex-live
#   ./run-forever.sh
#   (Ctrl+B depois D para desanexar sem matar o processo)
#
#   tmux attach -t latex-live   # para voltar depois
#
# Uso:
#   ./run-forever.sh
#   SITE_PASSWORD=outrasenha ./run-forever.sh
#   TUNNEL=off ./run-forever.sh   # só o servidor, sem túnel da Cloudflare (ex.:
#                                 # quando outro app publica este por um proxy)

set -uo pipefail
cd "$(dirname "$0")"

export SITE_PASSWORD="${SITE_PASSWORD:-tese2026}"
export PORT="${PORT:-4173}"
TUNNEL="${TUNNEL:-on}"

LOG_DIR="./.run-logs"
URL_FILE="./tunnel-url.txt"
mkdir -p "$LOG_DIR"

command -v node >/dev/null 2>&1 || {
  echo "ERRO: node não encontrado. Instale o Node.js antes de continuar."
  exit 1
}
[ "$TUNNEL" = "off" ] || command -v cloudflared >/dev/null 2>&1 || {
  echo "ERRO: cloudflared não encontrado."
  echo "Instale: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
}
command -v tectonic >/dev/null 2>&1 || {
  echo "AVISO: tectonic não encontrado no PATH — a compilação vai falhar até instalar."
  echo "Instale: https://tectonic-typesetting.github.io/en-US/"
}
[ -d node_modules ] || {
  echo "node_modules não existe ainda — rodando 'npm install'..."
  npm install
}

SERVER_PID=""
TUNNEL_PID=""

cleanup() {
  echo
  echo "Encerrando..."
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  rm -f "$URL_FILE"
  exit 0
}
trap cleanup INT TERM

echo "Senha de acesso: $SITE_PASSWORD"
echo "Logs em:         $LOG_DIR/"
echo "Link atual em:   $URL_FILE (atualizado a cada (re)início)"
echo "Ctrl+C para encerrar de vez."
echo

ts() { date '+%Y-%m-%d %H:%M:%S'; }

start_server() {
  echo "[$(ts)] iniciando servidor..."
  node server.js >> "$LOG_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  sleep 2
}

start_tunnel() {
  echo "[$(ts)] iniciando túnel..."
  # keep the previous run's log (it says why the last tunnel died)
  [ -f "$LOG_DIR/tunnel.log" ] && mv "$LOG_DIR/tunnel.log" "$LOG_DIR/tunnel.prev.log"
  cloudflared tunnel --protocol http2 --url "http://localhost:$PORT" >> "$LOG_DIR/tunnel.log" 2>&1 &
  TUNNEL_PID=$!

  URL=""
  for _ in $(seq 1 30); do
    URL="$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$LOG_DIR/tunnel.log" | tail -1 || true)"
    [ -n "$URL" ] && break
    sleep 1
  done

  if [ -n "$URL" ]; then
    echo "$URL" > "$URL_FILE"
    echo "[$(ts)] link: $URL"
  else
    echo "[$(ts)] não consegui capturar o link — veja $LOG_DIR/tunnel.log"
  fi
}

start_server
if [ "$TUNNEL" = "off" ]; then
  rm -f "$URL_FILE"
  echo "[$(ts)] sem túnel (TUNNEL=off): servidor em http://localhost:$PORT"
else
  start_tunnel
fi

# Each process is restarted on its own: the tunnel drops far more often than
# the server crashes (flaky networks), and restarting the server along with
# it used to cut off in-flight requests (e.g. an assistant reply) for no
# reason. The public link still changes whenever the tunnel restarts.
while true; do
  sleep 5
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    wait "$SERVER_PID"; echo "[$(ts)] servidor caiu (código $?) — reiniciando o servidor em 5s..."
    sleep 5
    start_server
  fi
  if [ "$TUNNEL" != "off" ] && ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    wait "$TUNNEL_PID"; echo "[$(ts)] túnel caiu (código $?) — reiniciando o túnel em 5s..."
    rm -f "$URL_FILE"
    sleep 5
    start_tunnel
  fi
done
