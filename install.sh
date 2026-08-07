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
		PATH="$NAMZU_PREFIX/bin:$PATH"
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
have namzu || die "installed, but 'namzu' is not on PATH.
  The files are in ${NAMZU_PREFIX}/bin. Add it to your PATH:
    export PATH=\"${NAMZU_PREFIX}/bin:\$PATH\""

NAMZU_INSTALLED="$(namzu --version 2>/dev/null || true)"
[ -n "$NAMZU_INSTALLED" ] || die "'namzu' is on PATH but did not answer --version.
  Run 'namzu doctor' to see what it says about itself."

say "namzu ${NAMZU_INSTALLED} installed."

if [ "$INSTALL_MODE" = prefix ]; then
	say ""
	say "It went to ${NAMZU_PREFIX}, which is not on your PATH by default."
	say "Add this to your shell profile:"
	say ""
	say "    export PATH=\"${NAMZU_PREFIX}/bin:\$PATH\""
fi

say ""
say "Next: run 'namzu doctor' to check credentials and sandboxing,"
say "or just 'namzu' to open the terminal agent."
