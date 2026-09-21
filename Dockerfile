# syntax=docker/dockerfile:1
FROM node:20-slim

# Install Tectonic (the LaTeX engine) system-wide, as root, before dropping
# to an unprivileged user. Uses the project's official install script.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh \
  && mv tectonic /usr/local/bin/tectonic \
  && rm -rf /var/lib/apt/lists/*

# Hugging Face Spaces run containers as UID 1000 — create a matching user so
# files written at runtime (compiled PDFs, uploaded assets) aren't owned by
# root. See https://huggingface.co/docs/hub/en/spaces-sdks-docker#permissions
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

COPY --chown=user package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=user . .

ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
