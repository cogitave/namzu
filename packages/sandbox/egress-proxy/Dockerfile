# =============================================================================
# @namzu/sandbox container-tier egress proxy image
# =============================================================================
# The sibling container the docker backend runs when a sandbox is created under
# a host-allowlist egress policy (`src/backends/docker/index.ts`,
# `renderEgressProxyRunArgs`). It is dual-homed: attached to the `--internal`
# network the sandbox is on, and to an ordinary bridge through which it reaches
# the internet. The sandbox itself is attached to the internal network only,
# which has no route off it: the only way the sandbox's traffic reaches the
# internet is through this container — and it is a container on a subnet, so
# whatever else a host attaches to that same network (a second sandbox, that
# sandbox's proxy) is reachable from the sandbox too.
#
# WHY THIS IMAGE EXISTS RATHER THAN A BIND MOUNT. The proxy is
# `src/egress/proxy.ts` — a Node module, and deliberately nothing else: it
# imports `node:http`, `node:https`, `node:net` and its own two siblings. The
# obvious economy would be to run the sandbox's own image with a different
# command and bind the built module in from wherever `@namzu/sandbox` is
# installed. That works on a developer's machine and breaks on the deployment
# this backend documents most carefully: when the SDK runs inside a container
# and drives a *remote* daemon (`hostReachability: 'container-network'`), the
# path it would bind is on the SDK container's filesystem and the daemon cannot
# see it. Docker materialises an empty directory instead, `node` exits
# `MODULE_NOT_FOUND`, and the sandbox is left with no route to the internet and
# a proxy URL that resolves to nothing. Baking the module into an image is the
# shape that survives both deployments, and it is the shape the other two
# images in this package already use.
#
# BUILD IT FROM `packages/sandbox`, AFTER BUILDING THE PACKAGE. The build
# context is this directory's parent (same convention as `worker/Dockerfile`
# and `k8s/Dockerfile`), and the COPY below takes the COMPILED module, so
# `dist/egress` has to exist:
#
#   pnpm --filter @namzu/sandbox build
#   docker build -f packages/sandbox/egress-proxy/Dockerfile \
#     -t namzu-egress-proxy:latest packages/sandbox
#
# `.github/workflows/sandbox-smoke.yml` runs exactly that, so the tag is known
# to build; nothing in this repository pushes it. A host names the image it
# built in `ContainerBackendConfig.egressProxyImage`, the same way it names
# `image`, and the backend refuses an allowlist policy that does not name one
# rather than starting a sandbox whose boundary does not exist.
#
# Distro choice: the same lineage as the other two images (`node:22` on Debian
# bookworm slim rather than Alpine), for the reason stated in `worker/Dockerfile`
# — and here for a second one: this image runs the same compiled JavaScript the
# in-process proxy runs, so it should be the same platform that module is
# tested on, not a second libc it has never been run against.
# =============================================================================

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

# Which configuration version this image's entrypoint reads. `2` adds port
# rules (`NAMZU_EGRESS_PROXY_CONFIG_V2`). The docker backend reads this label
# with `docker image inspect` before starting a proxy whose egress profile
# carries ports, and refuses an image without it, because the other signal (the
# container exiting on a configuration it cannot read) can arrive after the
# backend's readiness check has passed. See EGRESS_PROXY_IMAGE_CONFIG_LABEL in
# `src/backends/docker/index.ts`.
LABEL ai.namzu.egress-proxy.config="2"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production

# Same uid:gid the other two images in this package use for their unprivileged
# user (`worker/Dockerfile`'s `namzu:1001`), so one convention covers the
# package. Nothing here needs root: the process reads its configuration from
# the environment, binds a port above 1024 and makes outbound connections.
ARG PROXY_UID=1001
ARG PROXY_GID=1001
RUN groupadd --system --gid ${PROXY_GID} namzu \
    && useradd --system --uid ${PROXY_UID} --gid namzu --create-home namzu

# Strip every set-id (setuid/setgid) bit this base image carries, as
# `k8s/Dockerfile` does and for the same reason: this container runs with
# `--cap-drop=ALL` and `--security-opt=no-new-privileges` (see `HARDENING_ARGS`
# in `src/backends/docker/index.ts`), so a setuid binary in it could not regain
# anything anyway. Clearing them is defence in depth for the case where one of
# those two flags is relaxed later by someone who believes the other alone
# holds — this image sits between untrusted code and the internet, which is the
# last place to leave a belt unexamined because the braces look fine.
#
# `-xdev`: stay on this layer's own filesystem. `-perm /6000`: either the
# setuid (04000) or the setgid (02000) bit, not both required.
RUN find / -xdev -perm /6000 -type f -exec chmod ug-s {} +

# The boundary itself, exactly as `tsc` emitted it — the same files the
# in-process proxy loads. `dist/egress` is self-contained: every import in it
# is a `node:` builtin or a sibling in the same directory, which is what makes
# copying one directory a complete image.
COPY dist/egress /opt/namzu-egress/egress
COPY egress-proxy/server.mjs /opt/namzu-egress/server.mjs

# Those are ESM sources. A `.js` file with no `package.json` above it is
# CommonJS to Node, and the first `import` in `egress/index.js` would fail with
# "Cannot use import statement outside a module" — a failure that happens
# inside the container, after the sandbox has already been given this container
# as the only way its traffic reaches the internet. The marker is written here
# rather than committed as a `package.json` in this directory so that nothing
# walks up from a stray manifest and treats this Dockerfile's home as a Node
# package.
RUN printf '{"type":"module"}\n' > /opt/namzu-egress/package.json \
    && chown -R namzu:namzu /opt/namzu-egress

USER namzu

# The port `PROXY_PORT_INSIDE_CONTAINER` names in the backend. Declared rather
# than assigned: the value is the backend's, this line only says so.
EXPOSE 2025

# No `dumb-init`, unlike the worker image: this process spawns nothing, so the
# reaping a subreaper exists for has nothing to reap. It handles SIGTERM itself
# (`server.mjs`), which is what `docker rm -f` sends first.
CMD ["node", "/opt/namzu-egress/server.mjs"]
