#!/bin/sh
# =============================================================================
# @namzu/sandbox kubernetes-backend guest entrypoint
# =============================================================================
# Container pid 1, no init between this script and the kernel. Runs as
# root ONLY on a pod whose securityContext starts it that way — today, only
# sandboxtemplate-workspace.yaml, which needs root up front to format and
# mount a raw block device. sandboxtemplate-task.yaml's pod (and the kind
# overlay's filesystem-mode workspace variant) starts as the unprivileged
# `namzu` uid/gid directly, via `runAsUser`/`runAsGroup`, and this script's
# very first check below (`id -u`) picks the branch that matches. One job,
# in order:
#
#   1. ROOT ONLY: a workspace pod names a raw block device
#      (NAMZU_WORKSPACE_DEVICE); format it ONLY if it carries no filesystem
#      yet, then mount it at NAMZU_WORKSPACE_ROOT. A task pod sets no
#      device and — now started non-root — never reaches this step at all:
#      its workspace is just a directory inside the image (or an emptyDir
#      the pod spec mounted there), already owned by the unprivileged user
#      at image build time. A NON-ROOT pod that DOES set a device cannot
#      format or mount it (no CAP_SYS_ADMIN) and is refused outright rather
#      than silently skipping a workspace's disk — see the uid check below.
#   2. `exec` into `setpriv`, which drops every privilege this process
#      could still have and becomes `tini`, running as the unprivileged
#      user, which in turn execs the guest agent as ITS child. On the root
#      path this is a real privilege drop (`--reuid`/`--regid`/
#      `--clear-groups`/`--inh-caps=-all`/`--bounding-set=-all`); on the
#      non-root path the pod's securityContext (`runAsUser`,
#      `capabilities: drop: [ALL]`) already did that work, and this script
#      only adds `--no-new-privs`, which does not depend on the runtime
#      honouring `allowPrivilegeEscalation: false` (`--clear-groups`,
#      `--inh-caps` and `--bounding-set` all need capabilities
#      (CAP_SETGID/CAP_SETPCAP) a non-root start does not have, so the
#      identical flags would simply fail there). Either way `exec`
#      REPLACES this shell's process image — nothing of this script keeps
#      running or stays resident: `tini` ends up as the container's pid 1,
#      in the SAME mount namespace the root path's mount above (if any)
#      just populated, with no propagation step needed because there is
#      only ever one container and one namespace. `tini` as pid 1 (not the
#      agent itself) is a real subreaper: it reaps an orphan reparented to
#      pid 1 — which the agent's own `child_process` never would, since it
#      only `waitpid()`s processes it spawned directly — and forwards
#      `SIGTERM` to the agent, which stops accepting connections, stops
#      every process it is running and flushes the workspace filesystem
#      before it exits (`agent-sigterm.test.ts`).
#
# This script has ONE other job, and it is the tail of the same one: run
# with the single argument `prestop` it is the workspace pod's `preStop`
# hook rather than its entrypoint — see the "termination" section below. A
# pod that stops without its disk flushed keeps whatever the guest kernel
# happened to write back, which is the defect #484 exists to close.
#
# Before either exec, both branches export a writable HOME (plus USER,
# LOGNAME and the XDG cache/config vars) for the agent uid — `setpriv`
# changes credentials, never the environment, so without this HOME would
# stay whatever it was before the drop (`/root` on the root path, which
# #469 already verified the agent uid cannot use). See "HOME for the
# guest agent" below for the resolution order.
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

# =============================================================================
# TERMINATION: the flush a stopping pod's disk depends on.
#
# `sandboxtemplate-workspace.yaml` names this as the container's `preStop`
# hook, which the kubelet runs BEFORE it sends the stop signal and waits for
# — the one moment in a pod's teardown that is not a race. Three steps, in
# this order and for these reasons:
#
#   1. `sync -f` the workspace mount. `syncfs(2)` on the filesystem holding
#      that path: every dirty page of every file on it, whichever process
#      wrote it. It runs FIRST because it needs nothing of the agent — an
#      image whose agent predates this, a wedged agent, an agent already
#      gone — and it is the bulk of the work. A plain `sync` is NOT a
#      fallback, here or in the agent (`agent/agent.cjs`, `flushCommand`):
#      it flushes every mounted filesystem, and on a runtime that shares
#      the host kernel that is the node's disks and every other pod's
#      writes on them, spent by whichever pod happened to stop. An image
#      whose `sync` cannot do `-f` (a busybox coreutils) gets no flush from
#      this hook and none from the agent, and `healthz` stops advertising
#      `flush` so the host is told rather than left to assume — a gap to
#      report, not a node's IO to spend.
#   2. Signal the init (pid 1, `tini`), which forwards it to the agent. The
#      agent stops every process the guest is running and syncs again — the
#      delta the first sync could not cover, because those processes were
#      still writing when it ran. Measured in #484: on the VM runtime
#      tested, a stop signal from the kubelet did not get the handler run
#      before the container was killed, while this same signal from INSIDE
#      the guest ended it cleanly.
#
#      IT IS CHECKED BEFORE IT IS SENT. The only process this hook ever
#      signals is the init THIS image starts, and `/proc/<pid>/comm` has to
#      say so first. `kill` is a POSIX shell BUILTIN — no PATH shim can
#      stand in front of it — so this is the only place the check can live,
#      and the default pid it guards is 1: outside the container's own PID
#      namespace (a developer's machine, a suite running as root inside an
#      ordinary container) pid 1 is THAT machine's init, and an unguarded
#      `kill -TERM 1` there ends the machine rather than the pod. /proc is
#      already a hard requirement of this image — the agent walks it to
#      quiesce — so the check costs nothing and adds no dependency. A pid
#      whose name cannot be read, or that names something else, is NOT
#      signalled: the hook says so on stderr and returns, leaving the sync
#      above and the agent's own SIGTERM handler as the flush. Failing
#      closed costs a drain the kubelet's own stop signal asks for a moment
#      later; failing open costs whatever that pid happened to be.
#   3. Wait for the init to go, for LONGER than the agent's own shutdown
#      deadline. A hook that signalled and returned would race the kill
#      that follows it, which is the whole failure this replaces — and a
#      hook that waited for LESS than the agent's deadline would be a
#      quieter version of the same bug. The kubelet's teardown is: run
#      this hook, wait for it to return, then send its own stop signal to
#      pid 1. So a short wait ends the hook while the agent is still
#      draining, and the agent then has to survive a signal the kubelet
#      sent only because this gave up. The wait is therefore DERIVED from
#      NAMZU_AGENT_SHUTDOWN_DEADLINE_MS (rounded up to seconds, plus two)
#      rather than fixed, and raising that raises this with it. It is
#      still bounded: when it expires the hook returns anyway, because the
#      pod's `terminationGracePeriodSeconds` is the real bound and nothing
#      here may outlive it.
#
# EXPECT A `FailedPreStopHook` EVENT ON A STOP THAT WORKED. This hook runs
# inside the container's own pid namespace and step 2 ends pid 1 of that
# namespace; when pid 1 exits the kernel SIGKILLs everything left in it,
# this hook included, so the `exit 0` below is reached only on the paths
# where the init did NOT go — the bounded wait expiring, or a signal that
# never landed. The kubelet records the hook's death as a warning. It is
# the hook working, not failing: the flush and the drain both completed
# before pid 1 could exit. Returning before pid 1 is gone is the only way
# to avoid the event, and it would reintroduce exactly the race step 3
# exists to close.
#
# Neither mechanism is trusted alone. Whether a kubelet runs a preStop hook
# under a VM runtime class was never measured, so the agent's own SIGTERM
# handler performs the same drain and the same flush independently; and the
# host asks the guest to flush over the wire before it patches a workspace
# to Suspended. Three paths to the same guarantee, because each of them can
# be the one that does not fire.
#
# `NAMZU_PRESTOP_INIT_PID` and `NAMZU_PRESTOP_WAIT_SECONDS` exist so this
# can be driven by a test harness that has no PID namespace of its own — a
# test must never signal a process it did not start — and so an operator can
# override the wait outright. Neither is set by any manifest here, and
# NAMZU_PRESTOP_WAIT_SECONDS is deliberately not: pinning it to a literal
# would freeze the derivation above, so that raising the agent's deadline
# left the hook giving up early again. Setting it TAKES OVER from the
# derivation, so an operator who sets it owns the relationship between the
# two and should keep it above ceil(NAMZU_AGENT_SHUTDOWN_DEADLINE_MS/1000).
#
# `NAMZU_PRESTOP_INIT_PID` is not a licence to signal, and never was: the
# name check above applies to whatever pid it names, so pointing it at an
# arbitrary process still signals nothing. `NAMZU_PRESTOP_INIT_NAME` is the
# other half of the same knob — the name that check expects, defaulting to
# the `tini` this script execs at its tail. A derived image that boots a
# different init (dumb-init, s6) sets it; one that does not gets the stderr
# line and the agent's own handler, which is the safe half of the trade.
# =============================================================================
if [ "${1:-}" = "prestop" ]; then
	PRESTOP_INIT_PID="${NAMZU_PRESTOP_INIT_PID:-1}"
	case "$PRESTOP_INIT_PID" in
	'' | *[!0-9]*) PRESTOP_INIT_PID=1 ;;
	esac
	# The name `/proc/<pid>/comm` has to answer with before anything is
	# signalled — the basename of the init this script execs at its tail.
	PRESTOP_INIT_NAME="${NAMZU_PRESTOP_INIT_NAME:-tini}"
	# The agent's own bound, read from the same container environment the
	# agent reads it from, and defaulted to the same number the agent
	# defaults to. Read defensively both times: a pod is STOPPING here, and
	# aborting the flush over a mistyped environment variable would spend a
	# disk to enforce a validation rule.
	PRESTOP_DEADLINE_MS="${NAMZU_AGENT_SHUTDOWN_DEADLINE_MS:-15000}"
	case "$PRESTOP_DEADLINE_MS" in
	'' | *[!0-9]*) PRESTOP_DEADLINE_MS=15000 ;;
	esac
	PRESTOP_DERIVED_WAIT=$(((PRESTOP_DEADLINE_MS + 999) / 1000 + 2))
	PRESTOP_WAIT_SECONDS="${NAMZU_PRESTOP_WAIT_SECONDS:-$PRESTOP_DERIVED_WAIT}"
	case "$PRESTOP_WAIT_SECONDS" in
	'' | *[!0-9]*) PRESTOP_WAIT_SECONDS="$PRESTOP_DERIVED_WAIT" ;;
	esac
	sync -f "$WORKSPACE_ROOT" 2>/dev/null || true
	# What that pid actually IS, read with the shell's own `read` rather
	# than `cat` so no PATH has to supply anything. Unreadable (no such
	# process, no /proc) leaves it empty, which matches no expected name.
	PRESTOP_SEEN_NAME=''
	if [ -r "/proc/$PRESTOP_INIT_PID/comm" ]; then
		read -r PRESTOP_SEEN_NAME <"/proc/$PRESTOP_INIT_PID/comm" ||
			PRESTOP_SEEN_NAME=''
	fi
	if [ "$PRESTOP_SEEN_NAME" != "$PRESTOP_INIT_NAME" ]; then
		echo "entrypoint.sh: prestop: pid $PRESTOP_INIT_PID is '${PRESTOP_SEEN_NAME:-unreadable}', not the '$PRESTOP_INIT_NAME' this image starts — not signalling it; the workspace was synced and the agent's own SIGTERM handler is the drain" >&2
		exit 0
	fi
	kill -TERM "$PRESTOP_INIT_PID" 2>/dev/null || true
	# A fractional `sleep` is not POSIX, so which one this shell has is
	# settled ONCE, here, and the tick count is settled with it. Counting
	# tenths and then sleeping a whole second per tick when the fraction is
	# refused would make NAMZU_PRESTOP_WAIT_SECONDS mean ten times what it
	# says — 100 seconds at the default, past every grace period this
	# repo ships. The probe's own sleep is part of the wait either way.
	if sleep 0.1 2>/dev/null; then
		PRESTOP_SLEEP=0.1
		PRESTOP_TICKS=$((PRESTOP_WAIT_SECONDS * 10))
	else
		PRESTOP_SLEEP=1
		PRESTOP_TICKS="$PRESTOP_WAIT_SECONDS"
	fi
	while [ "$PRESTOP_TICKS" -gt 0 ]; do
		kill -0 "$PRESTOP_INIT_PID" 2>/dev/null || break
		sleep "$PRESTOP_SLEEP" || true
		PRESTOP_TICKS=$((PRESTOP_TICKS - 1))
	done
	exit 0
fi

# `setpriv` is needed on every pod, device or not — it is the very last
# command this script runs (see the exec at the tail). Checked up front,
# before anything else, so a missing `setpriv` is reported for what it is
# instead of surfacing as a confusing failure deep inside `exec`.
if ! command -v setpriv >/dev/null 2>&1; then
	echo "entrypoint.sh: required tool 'setpriv' not found on PATH ($PATH)" >&2
	exit 1
fi

# =============================================================================
# HOME for the guest agent and its children.
#
# `setpriv --reuid=/--regid=` below changes only the running process's
# credentials — it never touches the environment — so without this step
# HOME stays whatever it was before the drop (`/root`, since nothing here
# ever ran as anyone else). `agent.cjs`'s `childEnvironment` copies every
# `process.env` key that is not `NAMZU_AGENT_*`/`NAMZU_SANDBOX_*` into
# every `execute` and terminal child, so a broken HOME here reaches every
# process a task ever starts: LibreOffice without
# `-env:UserInstallation`, `pip install --user`, npm's cache, fontconfig
# and matplotlib all write under HOME and all fail against a directory
# the agent uid cannot use.
#
# Resolution order:
#   1. `getent passwd "$AGENT_UID"` field 6 — `k8s/Dockerfile`'s image
#      already creates this directory (`/home/namzu`) owned by the agent
#      uid, so this is the common case. A missing `getent` (a slimmed
#      derived image), a uid with no passwd entry, an entry naming a
#      directory under `$WORKSPACE_ROOT`, or one this uid still cannot be
#      made to own is a FALLBACK TRIGGER, never a failure — the expected
#      shape for a custom `NAMZU_AGENT_UID` or a stripped passwd db, not
#      something to report loudly. `getent` is deliberately NOT in the
#      tool-presence check above: its absence describes a slimmed image,
#      not a broken one.
#   2. `/tmp/namzu-home-$AGENT_UID`, created fresh, mode 0700, owned by
#      the agent uid. Deliberately never under `$WORKSPACE_ROOT` — a home
#      there would appear in every `listFiles`/`walkFiles` call and every
#      archive the workspace produces.
# Only if BOTH fail does this script refuse to start — nothing past this
# point works without a writable HOME anyway.
#
# `resolve_writable_dir` decides usability by ADOPTING the directory
# (create if missing, `chown` it to the agent uid/gid — exactly how
# `$WORKSPACE_ROOT` is chowned below — then reading the result back),
# never by POSIX `-w`: on the root path this script is STILL root when it
# runs this check, and `-w` succeeds for root on a directory the agent
# uid cannot write to at all — precisely the case this exists to catch.
resolve_writable_dir() {
	RWD_TARGET="$1"
	RWD_MODE="${2:-}"
	mkdir -p "$RWD_TARGET" 2>/dev/null || return 1
	chown "$AGENT_UID:$AGENT_GID" "$RWD_TARGET" 2>/dev/null || return 1
	if [ -n "$RWD_MODE" ]; then
		chmod "$RWD_MODE" "$RWD_TARGET" 2>/dev/null || return 1
	fi
	RWD_OWNER="$(stat -c '%u' "$RWD_TARGET" 2>/dev/null)" || return 1
	[ "$RWD_OWNER" = "$AGENT_UID" ]
}

HOME_DIR=""
HOME_USER=""
PASSWD_HOME=""
PASSWD_USER=""
if command -v getent >/dev/null 2>&1; then
	if PASSWD_ENTRY="$(getent passwd "$AGENT_UID")"; then
		PASSWD_HOME="$(printf '%s' "$PASSWD_ENTRY" | cut -d: -f6)"
		PASSWD_USER="$(printf '%s' "$PASSWD_ENTRY" | cut -d: -f1)"
	fi
fi

case "$PASSWD_HOME" in
	"")
		# getent absent, no entry for this uid, or the entry carries no
		# home field — nothing to adopt, fall through to the fallback.
		;;
	"$WORKSPACE_ROOT" | "$WORKSPACE_ROOT"/*)
		# Never adopt a passwd-resolved home under the workspace root —
		# see the header comment above. Treated exactly like "unusable".
		;;
	*)
		if resolve_writable_dir "$PASSWD_HOME"; then
			HOME_DIR="$PASSWD_HOME"
			HOME_USER="$PASSWD_USER"
		fi
		;;
esac

if [ -z "$HOME_DIR" ]; then
	FALLBACK_HOME="/tmp/namzu-home-$AGENT_UID"
	if resolve_writable_dir "$FALLBACK_HOME" 0700; then
		HOME_DIR="$FALLBACK_HOME"
		HOME_USER="namzu"
	else
		echo "entrypoint.sh: could not provision a writable HOME for uid $AGENT_UID: passwd entry (${PASSWD_HOME:-none}) unusable and fallback $FALLBACK_HOME also unusable; nothing past this point can run" >&2
		exit 1
	fi
fi
# =============================================================================

# Which branch this pod takes is decided by its ACTUAL uid, not by which
# template it thinks it is — a pod's securityContext is what actually
# determines this at the kernel level, and asking the kernel directly means
# a hand-edited or mismatched manifest is caught here rather than assumed.
CURRENT_UID="$(id -u)"

if [ "$CURRENT_UID" -ne 0 ]; then
	# NON-ROOT PATH: sandboxtemplate-task.yaml's pod (and the kind overlay's
	# filesystem-mode workspace variant), started directly as the
	# unprivileged uid/gid by its own securityContext. There is no
	# CAP_SYS_ADMIN here to format or mount anything, so a device is a
	# configuration error, not something to skip quietly — a template that
	# names one but forgot to also run its pod as root would otherwise look
	# like it worked while never actually formatting or mounting the disk
	# it was given.
	if [ -n "${NAMZU_WORKSPACE_DEVICE:-}" ]; then
		echo "entrypoint.sh: NAMZU_WORKSPACE_DEVICE is set but this container is running as uid $CURRENT_UID, not root; formatting or mounting a block device needs CAP_SYS_ADMIN, which a non-root pod does not have. A pod that names a device must start as root — see sandboxtemplate-workspace.yaml's securityContext, and do not set NAMZU_WORKSPACE_DEVICE on a template shaped like sandboxtemplate-task.yaml." >&2
		exit 1
	fi

	# The pod's own securityContext (runAsUser, capabilities: drop: [ALL],
	# allowPrivilegeEscalation: false) already dropped every capability
	# this process could have had — `--reuid`/`--regid`/`--clear-groups`/
	# `--inh-caps`/`--bounding-set` all need capabilities
	# (CAP_SETUID/CAP_SETGID/CAP_SETPCAP) this process does not have and
	# would simply fail with, unlike on the root path below. `--no-new-privs`
	# is the one flag still worth setting here itself: it is what makes
	# ../../src/backends/kubernetes/privilege-probe.ts's NoNewPrivs check
	# hold regardless of whether the runtime actually enforces
	# `allowPrivilegeEscalation: false` (Kubernetes does not guarantee every
	# runtime maps that field onto the kernel's own no_new_privs bit).
	export NAMZU_SANDBOX_WORKSPACE="$WORKSPACE_ROOT"
	export HOME="$HOME_DIR" USER="$HOME_USER" LOGNAME="$HOME_USER" \
		XDG_CACHE_HOME="$HOME_DIR/.cache" XDG_CONFIG_HOME="$HOME_DIR/.config"
	exec setpriv --no-new-privs -- /usr/bin/tini -- node /opt/namzu/agent.cjs
fi

# ROOT PATH: sandboxtemplate-workspace.yaml's pod, which starts as root
# specifically to format/mount its device before dropping every privilege
# itself, below.
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

# Same resolution as the non-root branch above, exported here too so
# neither exec site can be edited without the other — see "HOME for the
# guest agent and its children" near the top of this file.
export HOME="$HOME_DIR" USER="$HOME_USER" LOGNAME="$HOME_USER" \
	XDG_CACHE_HOME="$HOME_DIR/.cache" XDG_CONFIG_HOME="$HOME_DIR/.config"

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
