#!/usr/bin/env bash
# Prepara tudo numa máquina sem root (Node via nvm, tectonic, cloudflared)
# e deixa rodando via run-forever.sh. Seguro rodar de novo (pula o que já
# está instalado). Rode isso DENTRO de um tmux/screen:
#
#   tmux new -s latex-live
#   ./setup-cin.sh
#   (Ctrl+B depois D para desanexar sem matar o processo)

set -euo pipefail
cd "$(dirname "$0")"

LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
export PATH="$LOCAL_BIN:$PATH"
grep -qs 'HOME/.local/bin' "$HOME/.bashrc" 2>/dev/null || \
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"

echo "== Node.js =="
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
else
  echo "já instalado: $(node -v)"
fi

echo "== tectonic =="
if ! command -v tectonic >/dev/null 2>&1; then
  tmpdir="$(mktemp -d)"
  (cd "$tmpdir" && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh)
  mv "$tmpdir/tectonic" "$LOCAL_BIN/"
  rm -rf "$tmpdir"
else
  echo "já instalado: $(tectonic --version | head -1)"
fi

echo "== cloudflared =="
if ! command -v cloudflared >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "arquitetura desconhecida: $(uname -m) — baixe manualmente em https://github.com/cloudflare/cloudflared/releases"; exit 1 ;;
  esac
  curl -L -o "$LOCAL_BIN/cloudflared" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch"
  chmod +x "$LOCAL_BIN/cloudflared"
else
  echo "já instalado: $(cloudflared --version)"
fi

echo
echo "== node_modules =="
npm install

echo
echo "== tudo pronto, iniciando ./run-forever.sh =="
echo
exec ./run-forever.sh
