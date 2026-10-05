# Build explicitly: docker build -f packages/sandbox/local-computer/Dockerfile -t namzu-local-computer:1 packages/sandbox
# A Linux guest desktop inside a container; it shares the engine's kernel.
FROM docker.io/library/node:22-bookworm-slim

LABEL org.namzu.local-computer.protocol="1"
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb openbox chromium xdotool maim xterm dbus-x11 x11vnc \
    tint2 pcmanfm hsetroot adwaita-icon-theme \
    blender freecad gimp inkscape libreoffice-draw mousepad libgl1-mesa-dri \
    openscad kdenlive godot3 aisleriot qgis kicad paraview \
    fonts-dejavu fonts-noto-color-emoji ca-certificates \
    bash curl git ripgrep python3 dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 namzu \
    && useradd --uid 1001 --gid 1001 --create-home --shell /bin/bash namzu \
    && mkdir -p /home/namzu/workspace /home/namzu/.config/chromium \
    && chown -R 1001:1001 /home/namzu

# Kdenlive's real video-effect plug-ins; keep this separate from the large
# application layer so an existing app-equipped image retains its build cache.
RUN apt-get update && apt-get install -y --no-install-recommends frei0r-plugins \
    && rm -rf /var/lib/apt/lists/*

# Authenticated binary WebSocket transport only; VNC input remains disabled.
RUN npm install --prefix /opt/namzu-computer --omit=dev --ignore-scripts \
    --no-audit --no-fund ws@8.21.3

COPY worker/server.js /opt/namzu-computer/execution-worker.cjs
COPY local-computer/desktop-worker.cjs /opt/namzu-computer/desktop-worker.cjs
COPY local-computer/entrypoint.sh /opt/namzu-computer/entrypoint.sh
COPY local-computer/home.html /opt/namzu-computer/new-tab/home.html
COPY local-computer/new-tab /opt/namzu-computer/new-tab
COPY local-computer/app-catalog.cjs local-computer/app-native-host.cjs local-computer/prepare-home.cjs local-computer/browser-home.cjs /opt/namzu-computer/
COPY local-computer/tint2rc /opt/namzu-computer/tint2rc
COPY local-computer/openbox-rc.xml /opt/namzu-computer/openbox-rc.xml

# Catalogue/icon assets come only from installed Debian desktop entries. The
# native bridge is accepted solely from the bundled, fixed-id New Tab extension.
RUN chmod 0755 /opt/namzu-computer/app-native-host.cjs \
    && node /opt/namzu-computer/prepare-home.cjs

ENV HOME=/home/namzu DISPLAY=:99 GTK_THEME=Adwaita:dark \
    NAMZU_SANDBOX_WORKSPACE=/home/namzu/workspace \
    NAMZU_SANDBOX_READ_ROOTS=/home/namzu \
    NAMZU_SANDBOX_WRITE_ROOTS=/home/namzu \
    NAMZU_SANDBOX_IDLE_TIMEOUT_MS=0 \
    NAMZU_SANDBOX_NORMAL_EXIT_POLICY=computer-lifetime \
    NAMZU_SANDBOX_MAX_TIMEOUT_MS=2147000000 \
    NAMZU_SANDBOX_PORT=2024

WORKDIR /home/namzu/workspace
USER 1001:1001
EXPOSE 2024 2025
ENTRYPOINT ["/usr/bin/dumb-init", "--single-child", "--", "/bin/sh", "/opt/namzu-computer/entrypoint.sh"]
