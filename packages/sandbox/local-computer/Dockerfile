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

# File inspection and Kdenlive's real video-effect plug-ins; keep this separate from the large
# application layer so an existing app-equipped image retains its build cache.
RUN apt-get update && apt-get install -y --no-install-recommends file frei0r-plugins \
    && rm -rf /var/lib/apt/lists/*

# Use checksum-pinned supported application releases rather than Bookworm's
# Godot 3 and Blender 3 launchers. Retain the distribution tools for explicit
# legacy-project use; normal launches and the home catalogue use these binaries.
RUN mkdir -p /opt/namzu-apps \
    && curl --fail --location --retry 3 --output /tmp/godot.zip \
       https://github.com/godotengine/godot-builds/releases/download/4.7.2-stable/Godot_v4.7.2-stable_linux.x86_64.zip \
    && printf '%s  %s\n' cadd3204e728a35d3f13adb7fd0d7902636b79f6b95c40c265eb73b6c35329e4 /tmp/godot.zip | sha256sum --check --strict \
    && python3 -c "import zipfile; zipfile.ZipFile('/tmp/godot.zip').extractall('/opt/namzu-apps/godot-4.7.2')" \
    && chmod 0755 /opt/namzu-apps/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64 \
    && ln -s /opt/namzu-apps/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64 /usr/local/bin/godot \
    && ln -s /opt/namzu-apps/godot-4.7.2/Godot_v4.7.2-stable_linux.x86_64 /usr/local/bin/godot4 \
    && curl --fail --location --retry 3 --output /tmp/blender.tar.xz \
       https://download.blender.org/release/Blender5.2/blender-5.2.2-linux-x64.tar.xz \
    && printf '%s  %s\n' 84098912789dc450e95697c4184fb8a90acbe5111c2ba4aede3fecb57806a168 /tmp/blender.tar.xz | sha256sum --check --strict \
    && python3 -c "import tarfile; tarfile.open('/tmp/blender.tar.xz').extractall('/opt/namzu-apps')" \
    && ln -s /opt/namzu-apps/blender-5.2.2-linux-x64/blender /usr/local/bin/blender \
    && /usr/local/bin/godot4 --version \
    && /usr/local/bin/blender --version \
    && rm /tmp/godot.zip /tmp/blender.tar.xz

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
    BLENDERMCP_NO_UPDATE_CHECK=1 BLENDER_MCP_DISABLE_TELEMETRY=1 \
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
