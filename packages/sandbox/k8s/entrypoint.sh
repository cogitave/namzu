#!/bin/sh
# =============================================================================
# @namzu/sandbox kubernetes-backend guest entrypoint
# =============================================================================
# Runs as root (container pid 1, no init between this script and the
# kernel). One job, in order:
#
#   1. A workspace pod names a raw block device (NAMZU_WORKSPACE_DEVICE);
#      format it ONLY if it carries no filesystem yet, then mount it at
#      NAMZU_WORKSPACE_ROOT. A task pod sets no device and this whole step
#      is skipped — its workspace is just a directory inside the image
#      (or an emptyDir the pod spec mounted there), already owned by the
#      unprivileged user at image build time.
#   2. `exec` into `setpriv`, which drops every privilege this process has
#      and becomes the guest agent. `exec` REPLACES this shell's process
#      image — nothing of this script keeps running or stays resident: the
#      agent ends up as the container's pid 1, in the SAME mount namespace
#      the mount above just populated, with no propagation step needed
#      because there is only ever one container and one namespace.
#
# The one destructive mistake this file exists to make impossible: running
# mkfs unconditionally. A workspace's disk is formatted exactly ONCE, at
# first bind — every later resume the SandboxTemplate's `Sandbox` mounts the
# same PVC, already formatted, and an mkfs there would erase every byte the
# previous session wrote. `blkid` is the guard: it is asked what filesystem
# the device already carries, and mkfs runs only when the answer is "none".
#
# POSIX sh only — no bashisms. Verified with `sh -n` and, where installed,
# `dash -n` (see `k8s/__tests__/entrypoint.test.ts`), the same two-shell
# check the repo already runs `install.sh` through.
# =============================================================================

set -eu

WORKSPACE_ROOT="${NAMZU_WORKSPACE_ROOT:-/workspace}"
AGENT_UID="${NAMZU_AGENT_UID:-1001}"
AGENT_GID="${NAMZU_AGENT_GID:-1001}"

if [ -n "${NAMZU_WORKSPACE_DEVICE:-}" ] && [ -b "$NAMZU_WORKSPACE_DEVICE" ]; then
	# `-o value` prints just the value (or nothing) with no `TYPE=` label to
	# strip; `-s TYPE` asks for exactly the field that answers "is there a
	# filesystem here at all". blkid exits non-zero on an unrecognized
	# (unformatted) device — folded into an empty FS_TYPE with `|| true`
	# INSIDE the substitution, so `set -e` never sees that failure and the
	# script does not abort on the exact case it exists to handle.
	FS_TYPE="$(blkid -o value -s TYPE "$NAMZU_WORKSPACE_DEVICE" 2>/dev/null || true)"

	if [ -z "$FS_TYPE" ]; then
		# Reached only when blkid found no filesystem — see the guard above.
		# `-F` because a device that WAS formatted at some point but blkid
		# no longer recognises (a wiped superblock) should still format
		# clean rather than have mkfs refuse an "already in use" prompt it
		# cannot ask interactively.
		mkfs.ext4 -F "$NAMZU_WORKSPACE_DEVICE"
	fi

	mkdir -p "$WORKSPACE_ROOT"
	mount -o noatime,nodev,nosuid "$NAMZU_WORKSPACE_DEVICE" "$WORKSPACE_ROOT"
	chown "$AGENT_UID:$AGENT_GID" "$WORKSPACE_ROOT"
fi
# else: no device configured (a task pod) — nothing to format or mount.
# WORKSPACE_ROOT is whatever the image already owns (see the Dockerfile's
# `chown namzu:namzu /workspace`) or a pod-level volume the template mounted
# there under its own ownership; this script does not touch it either way.

# The guest agent reads its serving root from NAMZU_SANDBOX_WORKSPACE, a
# name that predates this backend (it is also the container-tier worker's
# variable). Exporting it here, from whatever WORKSPACE_ROOT actually is,
# means a workspace template only has to set NAMZU_WORKSPACE_ROOT correctly
# once — it does not also have to keep a second env var in the pod spec in
# sync with it by convention.
export NAMZU_SANDBOX_WORKSPACE="$WORKSPACE_ROOT"

# `exec`, not a plain call: this replaces the shell's own process image, so
# no root process is left resident beside the agent. `setpriv` drops the
# capability bounding set AND the inheritable set (a bare uid/gid change
# leaves capabilities that survive an exec into a setuid helper), and
# `--no-new-privs` stops any setuid binary inside the guest from regaining
# them. `../src/backends/kubernetes/privilege-probe.ts` verifies exactly
# these four masks are zero and NoNewPrivs is 1 on every single acquire —
# this line is the thing it is checking actually happened, not merely
# configured.
exec setpriv \
	--reuid="$AGENT_UID" \
	--regid="$AGENT_GID" \
	--clear-groups \
	--inh-caps=-all \
	--bounding-set=-all \
	--no-new-privs \
	-- node /opt/namzu/agent.cjs
