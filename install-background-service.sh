#!/usr/bin/env bash
# Instala o LaTeX Live como serviço em segundo plano no macOS (launchd):
# fica rodando mesmo sem nenhum terminal aberto, reinicia sozinho se cair
# ou se você reiniciar o Mac. Rode uma vez.
#
# Uso:
#   ./install-background-service.sh
#   SITE_PASSWORD=outrasenha ./install-background-service.sh

set -euo pipefail
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"
PLIST_NAME="com.latexlive.share.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/.run-logs"

sed "s#__PROJECT_DIR__#$PROJECT_DIR#g" "$PLIST_NAME" > "$DEST"

if [ -n "${SITE_PASSWORD:-}" ]; then
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:SITE_PASSWORD $SITE_PASSWORD" "$DEST"
fi

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"

echo "Instalado e rodando em segundo plano (sem precisar de terminal aberto)."
echo "Aguardando o link aparecer..."
for _ in $(seq 1 30); do
  [ -f "$PROJECT_DIR/tunnel-url.txt" ] && break
  sleep 1
done

echo
if [ -f "$PROJECT_DIR/tunnel-url.txt" ]; then
  echo "Link:  $(cat "$PROJECT_DIR/tunnel-url.txt")"
else
  echo "Ainda sem link — confira $PROJECT_DIR/.run-logs/launchd.log"
fi
echo "Senha: ${SITE_PASSWORD:-tese2026}"
echo
echo "Comandos úteis:"
echo "  cat tunnel-url.txt                          # ver o link atual"
echo "  tail -f .run-logs/launchd.log                # ver os logs"
echo "  launchctl unload ~/Library/LaunchAgents/$PLIST_NAME   # parar"
echo "  launchctl load ~/Library/LaunchAgents/$PLIST_NAME     # religar"
