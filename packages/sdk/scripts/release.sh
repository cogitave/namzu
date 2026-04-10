#!/usr/bin/env bash
set -euo pipefail

# Namzu Release Script (local orchestration)
# Usage: ./scripts/release.sh <patch|minor|major> [--dry-run]
#
# What this script does (locally):
#   1. Validates clean working tree + main branch
#   2. Bumps version in package.json
#   3. Generates CHANGELOG.md via git-cliff (if available)
#   4. Runs local verification (lint + typecheck + build + test)
#   5. Commits, tags, pushes
#
# What happens next (on GitHub):
#   - release.yml workflow triggers on v* tag push
#   - Runs full CI: lint → typecheck → build → test
#   - Publishes to npm with provenance
#   - Creates GitHub Release
#
# Prerequisites: jq, git-cliff (optional, for changelog)

BUMP="${1:-}"
DRY_RUN="${2:-}"

if [[ -z "$BUMP" ]] || [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major> [--dry-run]"
  exit 1
fi

command -v jq >/dev/null 2>&1 || { echo "Install jq: brew install jq"; exit 1; }

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is dirty. Commit or stash changes first."
  exit 1
fi

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Must be on main branch (currently on: $BRANCH)"
  exit 1
fi

CURRENT=$(jq -r .version package.json)
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${VERSION}"

echo ""
echo "  Release: ${CURRENT} → ${VERSION} (${BUMP})"
echo "  Tag:     ${TAG}"
echo ""

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  if command -v git-cliff >/dev/null 2>&1; then
    echo "  [dry-run] Changelog preview:"
    git-cliff --tag "$TAG" --unreleased --strip header
  fi
  echo ""
  echo "  [dry-run] No changes made."
  exit 0
fi

# Bump version
TMPFILE=$(mktemp)
jq ".version = \"${VERSION}\"" package.json > "$TMPFILE" && mv "$TMPFILE" package.json

# Generate changelog (optional)
if command -v git-cliff >/dev/null 2>&1; then
  git-cliff --tag "$TAG" --unreleased --prepend CHANGELOG.md
else
  echo "  [warn] git-cliff not found — skipping changelog generation"
fi

# Local verification
echo "  Running local checks..."
pnpm verify || { echo "Verification failed — aborting release"; git checkout package.json CHANGELOG.md; exit 1; }

# Commit and tag
git add package.json CHANGELOG.md
git commit -m "chore(release): ${VERSION}"
git tag -a "$TAG" -m "Release ${VERSION}"

echo ""
echo "  Pushing to origin..."
git push origin main
git push origin "$TAG"

echo ""
echo "  Done! Tag ${TAG} pushed."
echo "  GitHub Actions will now: build → test → npm publish → create release."
echo "  Track: https://github.com/cogitave/namzu/actions"
echo ""
