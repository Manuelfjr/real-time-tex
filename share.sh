#!/usr/bin/env bash
# Roda o LaTeX Live localmente e abre um túnel público (Cloudflare Tunnel)
# apontando pra ele, com senha. Use sempre que quiser dar acesso aos
# orientadores. Pare com Ctrl+C — derruba os dois processos.
#
# Uso:
#   ./share.sh                  # usa a senha padrão abaixo
#   SITE_PASSWORD=outrasenha ./share.sh

set -euo pipefail
cd "$(dirname "$0")"

export SITE_PASSWORD="${SITE_PASSWORD:-tese2026}"
export PORT="${PORT:-4173}"

echo "Iniciando o servidor local na porta $PORT..."
node server.js &
SERVER_PID=$!

cleanup() {
  echo
  echo "Encerrando..."
  kill "$SERVER_PID" 2>/dev/null || true
  kill "$TUNNEL_PID" 2>/dev/null || true
  rm -f tunnel-url.txt
}
trap cleanup EXIT

sleep 1

TUNNEL_LOG="$(mktemp)"
cloudflared tunnel --protocol http2 --url "http://localhost:$PORT" > "$TUNNEL_LOG" 2>&1 &
TUNNEL_PID=$!

echo "Abrindo o túnel público..."
URL=""
for _ in $(seq 1 30); do
  URL="$(grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  if [ -n "$URL" ]; then break; fi
  sleep 1
done

echo
echo "========================================================"
if [ -n "$URL" ]; then
  echo "Link para compartilhar: $URL"
  echo "$URL" > tunnel-url.txt
else
  echo "Não consegui capturar o link ainda — veja $TUNNEL_LOG"
fi
echo "Senha de acesso:        $SITE_PASSWORD"
echo "========================================================"
echo

wait "$SERVER_PID" "$TUNNEL_PID"
