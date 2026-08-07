#!/bin/sh
# Install the namzu terminal agent.
#
#   curl -fsSL https://raw.githubusercontent.com/cogitave/namzu/main/install.sh | sh
#
# The repository URL is the one advertised, because it is the one that serves
# this file. A short vanity URL is a nicer thing to type and would be a claim
# about hosting nobody has set up; when it exists, it can be added here.
#
# POSIX sh on purpose: this runs before namzu exists, on whatever shell the
# machine has, and a bashism here is a failure on the one path that has no
# fallback. Verified with `sh -n` in CI.
#
# What it does, in order, refusing rather than guessing at every step:
#
#   1. Finds a Node runtime and checks it is new enough.
#   2. Installs @namzu/cli globally.
#   3. If the global prefix is not writable, retries into a user-owned prefix
#      instead of asking for a privilege escalation the caller did not offer.
#   4. Verifies the binary actually answers before claiming success.
#
# Step 4 is the point. An installer that ends at "the package manager exited 0"
# reports success for a binary that is not on PATH, which is the failure mode
# this script exists to remove.

set -eu

NAMZU_PKG="@namzu/cli"
NAMZU_MIN_NODE=20
# Pin with: NAMZU_VERSION=2.0.0 sh install.sh
NAMZU_VERSION="${NAMZU_VERSION:-latest}"
# Where a fallback install lands when the global prefix is not writable.
NAMZU_PREFIX="${NAMZU_PREFIX:-$HOME/.namzu}"

say() { printf '%s\n' "$*"; }
err() { printf 'install: %s\n' "$*" >&2; }

die() {
	err "$*"
	exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# The directory under `$1` that actually holds the binary, or nothing.
#
# Checked rather than computed. npm puts executables in `$prefix/bin` on unix
# and in `$prefix` itself on Windows, and the shipped `namzu` is `namzu`,
# `namzu.cmd` or `namzu.ps1` depending on the platform — so a single hard-coded
# path is wrong somewhere. It was: the "not on PATH" message below named
# `$NAMZU_PREFIX/bin` unconditionally, which is correct only on the fallback
# branch, so a successful GLOBAL install that was not on PATH sent the operator
# to an empty directory. That is the one place this script stopped verifying and
# started guessing, and it fired exactly when someone needed it to be right.
bin_dir_under() {
	for candidate in "$1/bin" "$1"; do
		for exe in namzu namzu.cmd namzu.ps1; do
			if [ -e "$candidate/$exe" ]; then
				printf '%s' "$candidate"
				return 0
			fi
		done
	done
	return 1
}

# Major version of `node -v` output (`v20.11.1` -> `20`).
node_major() {
	"$1" -v 2>/dev/null | sed 's/^v//; s/\..*$//'
}

# ---------------------------------------------------------------- node

have node || die "no Node runtime on PATH.
  namzu runs on Node ${NAMZU_MIN_NODE} or newer. Install it, then run this again."

NODE_MAJOR="$(node_major node)"
case "$NODE_MAJOR" in
'' | *[!0-9]*)
	die "could not read a version from 'node -v'.
  Got: $(node -v 2>&1 || echo '<no output>')"
	;;
esac

if [ "$NODE_MAJOR" -lt "$NAMZU_MIN_NODE" ]; then
	die "Node $(node -v) is too old.
  namzu needs Node ${NAMZU_MIN_NODE} or newer."
fi

have npm || die "found Node but no npm on PATH.
  npm ships with Node; a PATH that has one and not the other is usually a
  partial install. Reinstall Node, then run this again."

say "namzu: Node $(node -v), installing ${NAMZU_PKG}@${NAMZU_VERSION}"

# ---------------------------------------------------------------- install

# `--global` first. It is what most machines want and what puts `namzu` on PATH
# without touching the caller's shell profile.
if npm install --global --no-fund --no-audit "${NAMZU_PKG}@${NAMZU_VERSION}" >/dev/null 2>&1; then
	INSTALL_MODE=global
else
	# The common cause is an unwritable global prefix. Retry into a user-owned
	# one rather than re-running under sudo: a curl-to-shell script that
	# escalates privilege on failure is a script nobody should pipe into sh.
	say "namzu: global install failed, retrying into ${NAMZU_PREFIX}"
	mkdir -p "$NAMZU_PREFIX"
	if npm install --global --prefix "$NAMZU_PREFIX" --no-fund --no-audit \
		"${NAMZU_PKG}@${NAMZU_VERSION}" >/dev/null 2>&1; then
		INSTALL_MODE=prefix
		# Same reasoning as the failure path: locate it, do not compute it.
		# Falling back to `$NAMZU_PREFIX/bin` keeps the old behaviour when the
		# probe finds nothing, so the verification below still gets a chance to
		# report honestly instead of this line silently exporting nothing.
		PATH="$(bin_dir_under "$NAMZU_PREFIX" || printf '%s' "$NAMZU_PREFIX/bin"):$PATH"
		export PATH
	else
		die "install failed both globally and into ${NAMZU_PREFIX}.
  Re-run the install by hand to see why:
    npm install --global ${NAMZU_PKG}@${NAMZU_VERSION}"
	fi
fi

# ---------------------------------------------------------------- verify

# The binary has to answer. Exiting 0 from the package manager says the files
# landed, not that `namzu` resolves or runs.
if ! have namzu; then
	# Where it went depends on which branch ran, and the global branch's prefix
	# is npm's to report rather than ours to assume.
	if [ "$INSTALL_MODE" = prefix ]; then
		NAMZU_ROOT="$NAMZU_PREFIX"
	else
		NAMZU_ROOT="$(npm prefix --global 2>/dev/null || true)"
	fi

	NAMZU_BIN=''
	[ -n "$NAMZU_ROOT" ] && NAMZU_BIN="$(bin_dir_under "$NAMZU_ROOT" || true)"

	if [ -n "$NAMZU_BIN" ]; then
		die "installed, but 'namzu' is not on PATH.
  The binary is in ${NAMZU_BIN}. Add it to your PATH:
    export PATH=\"${NAMZU_BIN}:\$PATH\""
	fi

	# Nothing found. Say that, rather than naming a directory to cover the gap —
	# sending someone to a path that does not hold the binary is the failure this
	# branch exists to avoid, and doing it while sounding certain is worse than
	# admitting the install landed somewhere this script cannot see.
	die "installed, but 'namzu' is not on PATH and the binary could not be located.
  npm reported its global prefix as: ${NAMZU_ROOT:-<npm did not answer>}
  Find it and add its directory to your PATH:
    npm ls --global --parseable ${NAMZU_PKG}"
fi

NAMZU_INSTALLED="$(namzu --version 2>/dev/null || true)"
[ -n "$NAMZU_INSTALLED" ] || die "'namzu' is on PATH but did not answer --version.
  Run 'namzu doctor' to see what it says about itself."

say "namzu ${NAMZU_INSTALLED} installed."

if [ "$INSTALL_MODE" = prefix ]; then
	# The directory that was actually put on PATH above, so the line the operator
	# copies into their profile is the line this run proved works.
	NAMZU_BIN="$(bin_dir_under "$NAMZU_PREFIX" || printf '%s' "$NAMZU_PREFIX/bin")"
	say ""
	say "It went to ${NAMZU_PREFIX}, which is not on your PATH by default."
	say "Add this to your shell profile:"
	say ""
	say "    export PATH=\"${NAMZU_BIN}:\$PATH\""
fi

say ""
say "Next: run 'namzu doctor' to check credentials and sandboxing,"
say "or just 'namzu' to open the terminal agent."
