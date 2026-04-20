#!/usr/bin/env bash
# Pre-publish consumer install check (ses_012-bedrock-integration-feedback).
#
# Packs every publishable @namzu/* package tarball at its current workspace
# version, then installs them all together into a fresh throwaway project.
# If any peer range has drifted such that the new tarballs cannot resolve
# each other cleanly, `npm install` errors with ERESOLVE and this script
# exits non-zero — gating the Changesets publish step.
#
# Invoked from .github/workflows/release.yml only on the merged
# "Version Packages" PR commit. For every other push to main, the
# release workflow's `changesets/action` just refreshes the Version
# Packages PR and this script is not run.
#
# Runs locally too (for a pre-PR sanity check): just invoke it from repo root.

set -euo pipefail

WORKSPACE_ROOT="${GITHUB_WORKSPACE:-$(pwd)}"
PACK_DIR=$(mktemp -d -t namzu-pack.XXXXXX)
CONSUMER_DIR=$(mktemp -d -t namzu-consumer.XXXXXX)

cleanup() {
  rm -rf "$PACK_DIR" "$CONSUMER_DIR"
}
trap cleanup EXIT

echo "=== Packing publishable Namzu packages ==="
PUBLISHABLE=(
  sdk
  computer-use
  providers/anthropic
  providers/bedrock
  providers/http
  providers/lmstudio
  providers/ollama
  providers/openai
  providers/openrouter
)

for pkg_path in "${PUBLISHABLE[@]}"; do
  pkg_name=$(basename "$pkg_path")
  echo "  • @namzu/${pkg_name}"
  pnpm --dir "$WORKSPACE_ROOT" --filter "@namzu/${pkg_name}" pack --pack-destination "$PACK_DIR" >/dev/null
done

SDK_TARBALL=$(ls "$PACK_DIR"/namzu-sdk-*.tgz | head -1)
test -f "$SDK_TARBALL" || { echo "✗ Missing SDK tarball in $PACK_DIR"; exit 1; }
echo "  ✓ Packed $(ls "$PACK_DIR" | wc -l | tr -d ' ') tarballs → $PACK_DIR"

echo ""
echo "=== Consumer install dry-run ==="
cd "$CONSUMER_DIR"
npm init -y >/dev/null

# All dependents of SDK: 7 providers + computer-use. They all declare SDK in
# peerDependencies at ">=0.1.6 <1.0.0" (post-Changesets migration); the install
# will fail with ERESOLVE if any of the bumped versions falls outside that range.
DEPENDENTS=(anthropic bedrock computer-use http lmstudio ollama openai openrouter)

for dep in "${DEPENDENTS[@]}"; do
  echo ""
  echo "  → @namzu/${dep} + @namzu/sdk"
  TARBALL=$(ls "$PACK_DIR"/namzu-${dep}-*.tgz | head -1)
  test -f "$TARBALL" || { echo "    ✗ Missing tarball for $dep"; exit 1; }

  rm -rf node_modules package-lock.json
  npm install --no-fund --no-audit --silent "$SDK_TARBALL" "$TARBALL"

  test -d "node_modules/@namzu/${dep}" || { echo "    ✗ @namzu/${dep} did not install"; exit 1; }
  test -d "node_modules/@namzu/sdk" || { echo "    ✗ @namzu/sdk did not install"; exit 1; }
  echo "    ✓ resolved"
done

echo ""
echo "✅ Consumer install verified for all 8 SDK-dependent packages"
