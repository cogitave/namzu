# =============================================================================
# @namzu/sandbox kubernetes-backend guest image
# =============================================================================
# The image `sandboxtemplate-task.yaml` / `sandboxtemplate-workspace.yaml`
# name. One container, root at start, `entrypoint.sh` formats/mounts a
# workspace's raw block device (workspace templates only — see
# `NAMZU_WORKSPACE_DEVICE` below) and then `exec`s straight into the guest
# agent as an unprivileged user. No init container, no sidecar, no
# `mountPropagation`: the format-and-mount step and the agent must share one
# mount namespace, which only holds when they are the same container.
#
# This is deliberately NOT the fat `worker/Dockerfile` reference image one
# directory up (LibreOffice, pandoc, the full Python data/doc-gen stack,
# Chromium). That image serves the `container:docker` tier's HTTP worker,
# where the guest often IS the toolchain a task runs against directly. Here
# the guest agent's own protocol carries `exec`, so the pod's PATH is
# whatever the task pulls in itself (a task template can still `FROM` this
# image and layer more on, exactly as any other Dockerfile would); baking
# LibreOffice into every warm-pool replica this backend churns through would
# be pure image-pull and pool-refill cost paid by every deployment that never
# uses it.
#
# Distro choice: same lineage as `../worker/Dockerfile` (Debian bookworm
# slim over Alpine) for the same reason stated there — glibc, not musl,
# is what `manylinux`-wheel Python and Node native addons actually target,
# and this image is the base a task template's own image build starts from.
#
# Trust model: the boundary is the pod's `RuntimeClass` (Kata — see
# `manifests/runtimeclass.yaml`), not this image. The container starts as
# root ONLY to format/mount a block device and `chown` it before dropping
# every capability; nothing past the `exec` in `entrypoint.sh` runs as root
# or keeps any capability. See `entrypoint.sh` for the full sequence and
# `../src/backends/kubernetes/privilege-probe.ts` for how the host verifies
# it landed, on every single acquire, rather than trusting this Dockerfile.
# =============================================================================

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production

# util-linux: `setpriv` (the privilege drop `entrypoint.sh` execs into) and
# `blkid` (both ship in this package on Debian, not e2fsprogs, despite the
# tool's name suggesting otherwise).
# e2fsprogs: `mkfs.ext4`, for a workspace's block device on its first mount.
# tini: the container's real PID 1 once `entrypoint.sh` execs into it (see
# that file's tail). Without a subreaper there, the guest agent itself is
# PID 1 with no `waitpid()` for a process it never spawned directly, so a
# background job (`sh -c '... &'`) orphaned by a cancel-triggered `SIGKILL`
# reparents to the agent and is never reaped — root-caused with in-cluster
# `/proc` evidence in `research/k8s-sandbox/kind-e2e-results.md` ("Defect 2",
# `2026-09-16`). `tini` reaps it instead and forwards `SIGTERM`, which is
# exactly the job a subreaper is for; the agent's own `SIGTERM` handler
# (see `agent-sigterm.test.ts`) still runs, now as an ordinary signalled
# child rather than as PID 1.
RUN apt-get update && apt-get install -y --no-install-recommends \
    util-linux \
    e2fsprogs \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Same uid:gid the existing worker reference image uses for its unprivileged
# user (`../worker/Dockerfile`'s `namzu:1001`), so a task image layering on
# top of either one sees one convention. `useradd`/`groupadd` exist only so
# `namzu` resolves to something readable in `ps`/`ls -l` inside the
# container; `entrypoint.sh`'s `setpriv --reuid=--regid=` takes the numeric
# ids directly and never consults `/etc/passwd`.
ARG AGENT_UID=1001
ARG AGENT_GID=1001
RUN groupadd --system --gid ${AGENT_GID} namzu \
    && useradd --system --uid ${AGENT_UID} --gid namzu --create-home namzu \
    # Baked in for a task pod, which sets no NAMZU_WORKSPACE_DEVICE and so
    # never runs entrypoint.sh's mount branch at all — this directory IS
    # its workspace, already owned by the user setpriv drops to. A
    # workspace pod's device branch chowns its own mount target instead;
    # see entrypoint.sh.
    && mkdir -p /workspace \
    && chown namzu:namzu /workspace

COPY agent/agent.cjs /opt/namzu/agent.cjs
COPY k8s/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NAMZU_AGENT_UID=${AGENT_UID} \
    NAMZU_AGENT_GID=${AGENT_GID} \
    NAMZU_SANDBOX_WORKSPACE=/workspace \
    NAMZU_WORKSPACE_ROOT=/workspace

# Deliberately no `USER namzu` here — the entrypoint needs CAP_SYS_ADMIN
# (mount, mkfs) before it drops every capability itself. The pod's own
# `securityContext.privileged` (see `manifests/sandboxtemplate-*.yaml`) is
# what grants it; this image just does not fight that by switching user
# too early.
WORKDIR /workspace

EXPOSE 1024

ENTRYPOINT ["/entrypoint.sh"]
