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
# No Linux x86_64, usa o binário musl (estático): o do drop-sh depende de uma
# glibc recente e falha em servidores mais antigos ("GLIBC_2.39 not found").
TECTONIC_VERSION="${TECTONIC_VERSION:-0.17.0}"
if command -v tectonic >/dev/null 2>&1 && tectonic --version >/dev/null 2>&1; then
  echo "já instalado: $(tectonic --version | head -1)"
else
  command -v tectonic >/dev/null 2>&1 && echo "o tectonic instalado não roda nesta máquina — substituindo"
  tmpdir="$(mktemp -d)"
  if [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ]; then
    curl -fL -o "$tmpdir/t.tgz" "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz"
    tar -xzf "$tmpdir/t.tgz" -C "$tmpdir" tectonic
  else
    (cd "$tmpdir" && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh)
  fi
  mv "$tmpdir/tectonic" "$LOCAL_BIN/tectonic"
  rm -rf "$tmpdir"
  echo "instalado: $("$LOCAL_BIN/tectonic" --version | head -1)"
fi

echo "== ghostscript (figuras EPS) =="
# O tectonic não lê EPS; o LaTeX Live converte para PDF com o Ghostscript antes
# de compilar. Usa o gs do sistema, se houver; senão, o binário estático oficial
# da Artifex (10.0.0, o último publicado assim), conferido pelo SHA-256.
GS_URL="https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs1000/ghostscript-10.0.0-linux-x86_64.tgz"
GS_SHA256="176ad1cbad402ae5930521f954ad70dffaaf8d625cf508feeea4f9bf2e61f3d4"
if command -v gs >/dev/null 2>&1 && gs --version >/dev/null 2>&1; then
  echo "já instalado: gs $(gs --version)"
elif [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ]; then
  tmpdir="$(mktemp -d)"
  curl -fL -o "$tmpdir/gs.tgz" "$GS_URL"
  echo "$GS_SHA256  $tmpdir/gs.tgz" | sha256sum -c - >/dev/null || { echo "ERRO: o arquivo do Ghostscript não confere (SHA-256)."; exit 1; }
  tar -xzf "$tmpdir/gs.tgz" -C "$tmpdir"
  mv "$tmpdir/ghostscript-10.0.0-linux-x86_64/gs-1000-linux-x86_64" "$LOCAL_BIN/gs"
  chmod +x "$LOCAL_BIN/gs"
  rm -rf "$tmpdir"
  echo "instalado: gs $("$LOCAL_BIN/gs" --version)"
else
  echo "AVISO: instale o Ghostscript para compilar figuras EPS (ex.: brew install ghostscript)."
fi

echo "== cloudflared =="
if [ "${TUNNEL:-on}" = "off" ]; then
  echo "pulado (TUNNEL=off)"
elif ! command -v cloudflared >/dev/null 2>&1; then
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
