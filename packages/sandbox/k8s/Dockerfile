# =============================================================================
# @namzu/sandbox kubernetes-backend guest image
# =============================================================================
# The image `sandboxtemplate-task.yaml` / `sandboxtemplate-workspace.yaml`
# name. One container; `entrypoint.sh` formats/mounts a workspace's raw
# block device (workspace templates only, and only when the pod's own
# `securityContext` started it as root to do so — see `NAMZU_WORKSPACE_DEVICE`
# below) and then `exec`s straight into the guest agent as an unprivileged
# user either way. No init container, no sidecar, no `mountPropagation`: the
# format-and-mount step and the agent must share one mount namespace, which
# only holds when they are the same container.
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
# uses it. A task template's own image build (see the set-id step below)
# repeats this image's set-id-clearing step after its own installs, for the
# same reason it repeats the AGENT_UID/AGENT_GID convention: a package
# layered on afterward can reintroduce a setuid/setgid binary this image
# already removed.
#
# Distro choice: same lineage as `../worker/Dockerfile` (Debian bookworm
# slim over Alpine) for the same reason stated there — glibc, not musl,
# is what `manylinux`-wheel Python and Node native addons actually target,
# and this image is the base a task template's own image build starts from.
#
# Trust model: the boundary is the pod's `RuntimeClass` (Kata — see
# `manifests/runtimeclass.yaml`), not this image. Only
# `sandboxtemplate-workspace.yaml`'s pod starts as root, to format/mount a
# block device and `chown` it before dropping every capability itself;
# `sandboxtemplate-task.yaml`'s pod (and the kind overlay's filesystem-mode
# workspace variant) is non-root at the POD level from the very first
# process — no capability, no privilege escalation, see that manifest's own
# `securityContext` comment — and never takes a root step at all. Either way
# nothing past the `exec` in `entrypoint.sh` runs as root or keeps any
# capability. See `entrypoint.sh` for the full sequence and
# `../src/backends/kubernetes/privilege-probe.ts` for how the host verifies
# it landed, on every single acquire, rather than trusting this Dockerfile.
# This image also carries no set-id (setuid/setgid) binary (see the `find`
# step below) — defence in depth for any process that ever runs non-root
# without `--no-new-privs` set some other way, though nothing here depends
# on it: the probe and the entrypoint's own `--no-new-privs` already close
# that path.
# =============================================================================

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_ENV=production

# util-linux: `setpriv` (the privilege drop `entrypoint.sh` execs into),
# `blkid` (ships in this package on Debian, not e2fsprogs, despite the
# tool's name suggesting otherwise) and `mount`. `entrypoint.sh` checks
# `command -v` on all of these plus `dd` and `chown` (coreutils — part of
# every Debian base image, this slim one included, so not installed here)
# before it trusts blkid's answer about a workspace device; a derived image
# that strips coreutils or drops util-linux from its own layers loses that
# guard, not just a convenience.
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

# Strip every set-id (setuid/setgid) bit this base image carries. Debian's
# util-linux and e2fsprogs (installed above) ship `su`, `mount`, `umount`,
# `passwd`, `chsh`, `chfn`, `gpasswd`, `newgrp`, `chage`, `expiry` and
# `/usr/sbin/unix_chkpwd` with one bit or the other set — `find / -xdev
# -perm /6000 -type f` on an unmodified image lists exactly these. Nothing
# in THIS image needs any of them: `entrypoint.sh` runs `blkid`,
# `mkfs.ext4` and `mount` itself, as root, on the one pod that starts that
# way, before it ever drops privilege — none of that goes through a setuid
# helper — and the agent's own process tree runs under `--no-new-privs`
# (see `entrypoint.sh`'s tail, both branches), which
# `../src/backends/kubernetes/privilege-probe.ts` checks on every acquire,
# so a setuid binary left in the guest could not regain anything even if it
# were still there. Clearing them anyway is defence in depth for any
# process that ends up running non-root without `--no-new-privs` set some
# other way — it is not something the entrypoint or the probe depend on.
#
# `-xdev`: stay on this layer's own filesystem rather than descend into a
# bind mount or another filesystem a later build step might introduce.
# `-perm /6000`: either the setuid (04000) or the setgid (02000) bit, not
# both required — `find`'s `/MODE` form matches ANY bit in the given mask,
# unlike a bare numeric mode which would require an exact match.
#
# A task image that `FROM`s this one and layers its own packages on top
# MUST repeat this exact command after its own installs — a package
# installed afterward can reintroduce a setuid/setgid binary this step
# already removed (see this file's header comment).
RUN find / -xdev -perm /6000 -type f -exec chmod ug-s {} +

COPY agent/agent.cjs /opt/namzu/agent.cjs
COPY k8s/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NAMZU_AGENT_UID=${AGENT_UID} \
    NAMZU_AGENT_GID=${AGENT_GID} \
    NAMZU_SANDBOX_WORKSPACE=/workspace \
    NAMZU_WORKSPACE_ROOT=/workspace

# Deliberately no `USER namzu` here. `sandboxtemplate-workspace.yaml`'s pod
# needs CAP_SYS_ADMIN (mount, mkfs) as root before `entrypoint.sh` drops
# every capability itself, and an image `USER` cannot be un-set at the pod
# level — Kubernetes has no way to hand a capability back to a container
# whose image already switched to an unprivileged user.
# `sandboxtemplate-task.yaml`'s pod instead OVERRIDES the (absent) image
# user at the pod level, with `securityContext.runAsUser`/`runAsGroup` (see
# that manifest's own comment) — Kubernetes honours that override over an
# image with no `USER` directive at all, which is what lets ONE image with
# no `USER` serve both a pod that starts root and a pod that never does.
WORKDIR /workspace

EXPOSE 1024

ENTRYPOINT ["/entrypoint.sh"]
