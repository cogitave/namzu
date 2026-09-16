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
#      and becomes `tini`, running as the unprivileged user, which in turn
#      execs the guest agent as ITS child. `exec` REPLACES this shell's
#      process image — nothing of this script keeps running or stays
#      resident: `tini` ends up as the container's pid 1, in the SAME mount
#      namespace the mount above just populated, with no propagation step
#      needed because there is only ever one container and one namespace.
#      `tini` as pid 1 (not the agent itself) is a real subreaper: it reaps
#      an orphan reparented to pid 1 — which the agent's own
#      `child_process` never would, since it only `waitpid()`s processes it
#      spawned directly — and forwards `SIGTERM` to the agent, which still
#      handles it exactly as it always has (`agent-sigterm.test.ts`).
#
# The one destructive mistake this file exists to make impossible: running
# mkfs unconditionally. A workspace's disk is formatted exactly ONCE, at
# first bind — every later resume the SandboxTemplate's `Sandbox` mounts the
# same PVC, already formatted, and an mkfs there would erase every byte the
# previous session wrote. `blkid`'s EXIT STATUS is the guard, not merely
# whether it printed something: only status 2 ("no filesystem or
# partitions found", blkid(8)) — and only once a raw read of the device
# proves it can actually be probed — may lead to mkfs. blkid missing,
# unreadable, erroring, or answering with any other status is treated as
# "cannot tell", never as "empty", and aborts the pod instead of risking a
# reformat of a disk blkid simply failed to identify.
#
# POSIX sh only — no bashisms. Verified with `sh -n` and, where installed,
# `dash -n` (see `k8s/__tests__/entrypoint.test.ts`), the same two-shell
# check the repo already runs `install.sh` through.
# =============================================================================

set -eu

WORKSPACE_ROOT="${NAMZU_WORKSPACE_ROOT:-/workspace}"
AGENT_UID="${NAMZU_AGENT_UID:-1001}"
AGENT_GID="${NAMZU_AGENT_GID:-1001}"

# `setpriv` is needed on every pod, device or not — it is the very last
# command this script runs (see the exec at the tail). Checked up front,
# before anything else, so a missing `setpriv` is reported for what it is
# instead of surfacing as a confusing failure deep inside `exec`.
if ! command -v setpriv >/dev/null 2>&1; then
	echo "entrypoint.sh: required tool 'setpriv' not found on PATH ($PATH)" >&2
	exit 1
fi

if [ -n "${NAMZU_WORKSPACE_DEVICE:-}" ] && [ -b "$NAMZU_WORKSPACE_DEVICE" ]; then
	DEV="$NAMZU_WORKSPACE_DEVICE"

	# Every tool this branch can run, checked before any of them actually
	# do — a missing tool must never be mistaken for "blkid found no
	# filesystem" and fall through into a format. `dd` is the raw-read
	# probe used below to confirm a device blkid calls empty can truly be
	# read; the others are the format/mount/chown sequence itself.
	for tool in blkid dd mkfs.ext4 mount chown; do
		if ! command -v "$tool" >/dev/null 2>&1; then
			echo "entrypoint.sh: required tool '$tool' not found on PATH ($PATH)" >&2
			exit 1
		fi
	done

	# `-p`: low-level superblock/partition-table probing, which bypasses
	# blkid's cache (blkid(8)) — the cache could otherwise answer for a
	# device whose content has changed since it was last scanned. `-o
	# value -s TYPE` prints just the filesystem type with no `TYPE=` label
	# to strip.
	#
	# The exit status is captured explicitly with `&& … || …`, never
	# folded away with `2>/dev/null || true`: blkid's stderr is left to
	# flow to this script's own stderr (the container log), and only
	# status 2 is ever treated as "no filesystem" below. blkid(8)'s exit
	# statuses:
	#   0   a filesystem or partition signature WAS identified.
	#   2   nothing was identified — but blkid(8) also returns 2 when "it
	#       is impossible to gather any information about the device
	#       identifiers or device content", so this status alone is not
	#       proof the device is blank (see the dd probe below).
	#   4   usage or other error.
	#   8   ambivalent low-level probe result (only reachable in -p mode).
	#   126/127 the shell's own "found but not executable" / "not found"
	#       — the `command -v` check above should already have caught a
	#       missing blkid; this is the second line of defence.
	# Anything other than "0 with a non-empty value" or "2" — including a
	# bare 0 with an empty value, which `-s` cannot distinguish from "field
	# absent" — is treated the same as an error: abort, never format.
	FS_TYPE="$(blkid -p -o value -s TYPE "$DEV")" && BLKID_STATUS=0 || BLKID_STATUS=$?

	if [ "$BLKID_STATUS" -eq 0 ] && [ -n "$FS_TYPE" ]; then
		: # A filesystem was identified; skip mkfs and fall through to mount.
	elif [ "$BLKID_STATUS" -eq 2 ]; then
		# blkid says "nothing found", but that status also covers "could
		# not read the device at all" (see above) — so before trusting it
		# enough to format, confirm the device actually answers a read.
		# dd's own stderr is left unredirected for the same reason
		# blkid's is: a failure here must be diagnosable from the log, not
		# silently swallowed. Its data is discarded (of=/dev/null) — this
		# reads the device, it never inspects what is on it.
		if ! dd if="$DEV" of=/dev/null bs=512 count=1; then
			echo "entrypoint.sh: blkid exited 2 (no filesystem found) on $DEV, but the device could not be read; refusing to format it" >&2
			exit 1
		fi
		# `-F` because a device that WAS formatted at some point but blkid
		# no longer recognises (a wiped superblock) should still format
		# clean rather than have mkfs refuse an "already in use" prompt it
		# cannot ask interactively. Reached only for status 2 on a device
		# just proven readable — never for a blkid failure.
		mkfs.ext4 -F "$DEV"
	else
		echo "entrypoint.sh: blkid exited $BLKID_STATUS probing $DEV (not '0 with a filesystem' or '2'); refusing to format it" >&2
		exit 1
	fi

	mkdir -p "$WORKSPACE_ROOT"
	mount -o noatime,nodev,nosuid "$DEV" "$WORKSPACE_ROOT"
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
# configured. `setpriv` itself still execs (not spawns) into `tini`, so the
# privilege drop happens before pid 1 is even decided and `tini` never runs
# with a capability the agent it launches should not have either.
exec setpriv \
	--reuid="$AGENT_UID" \
	--regid="$AGENT_GID" \
	--clear-groups \
	--inh-caps=-all \
	--bounding-set=-all \
	--no-new-privs \
	-- /usr/bin/tini -- node /opt/namzu/agent.cjs
