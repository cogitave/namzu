# Build explicitly: docker build -f packages/sandbox/local-computer/Dockerfile -t namzu-local-computer:1 packages/sandbox
# A Linux guest desktop inside a container; it shares the engine's kernel.
FROM docker.io/library/node:22-bookworm-slim

LABEL org.namzu.local-computer.protocol="1"
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb openbox chromium xdotool maim xterm dbus-x11 \
    fonts-dejavu fonts-noto-color-emoji ca-certificates \
    bash curl git ripgrep python3 dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 namzu \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash namzu \
    && mkdir -p /home/namzu/workspace /home/namzu/.config/chromium \
    && chown -R 1001:1001 /home/namzu

COPY worker/server.js /opt/namzu-computer/execution-worker.cjs
COPY local-computer/desktop-worker.cjs /opt/namzu-computer/desktop-worker.cjs
COPY local-computer/entrypoint.sh /opt/namzu-computer/entrypoint.sh

ENV HOME=/home/namzu DISPLAY=:99 \
    NAMZU_SANDBOX_WORKSPACE=/home/namzu/workspace \
    NAMZU_SANDBOX_READ_ROOTS=/home/namzu \
    NAMZU_SANDBOX_WRITE_ROOTS=/home/namzu \
    NAMZU_SANDBOX_IDLE_TIMEOUT_MS=0 \
    NAMZU_SANDBOX_MAX_TIMEOUT_MS=2147000000 \
    NAMZU_SANDBOX_PORT=2024

WORKDIR /home/namzu/workspace
USER 1001:1001
EXPOSE 2024 2025
ENTRYPOINT ["/usr/bin/dumb-init", "--single-child", "--", "/bin/sh", "/opt/namzu-computer/entrypoint.sh"]
