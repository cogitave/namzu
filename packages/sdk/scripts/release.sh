#!/usr/bin/env bash
set -euo pipefail

# Namzu Release Script (local orchestration)
#
# Usage:
#   ./scripts/release.sh patch              # 0.1.3 → 0.1.4 (stable)
#   ./scripts/release.sh minor              # 0.1.3 → 0.2.0 (stable)
#   ./scripts/release.sh major              # 0.1.3 → 1.0.0 (stable)
#   ./scripts/release.sh rc                 # 0.1.3 → 0.2.0-rc.1 (pre-release)
#   ./scripts/release.sh rc                 # 0.2.0-rc.1 → 0.2.0-rc.2 (bump rc)
#   ./scripts/release.sh stable             # 0.2.0-rc.2 → 0.2.0 (promote to stable)
#   ./scripts/release.sh patch --dry-run    # Preview without changes
#
# What happens locally:
#   1. Validates clean working tree + main branch
#   2. Bumps version in package.json
#   3. Generates CHANGELOG.md via git-cliff (if available)
#   4. Runs local verification (lint + typecheck + build + test)
#   5. Commits, tags, pushes
#
# What happens on GitHub (release.yml):
#   - Detects stable vs pre-release from version string
#   - Publishes to npm with correct dist-tag (latest / rc / beta / alpha)
#   - Creates GitHub Release (pre-release flag for non-stable)
#
# Prerequisites: jq, git-cliff (optional)

BUMP="${1:-}"
DRY_RUN="${2:-}"

if [[ -z "$BUMP" ]] || [[ ! "$BUMP" =~ ^(patch|minor|major|rc|beta|alpha|stable)$ ]]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major|rc|beta|alpha|stable> [--dry-run]"
  echo ""
  echo "  patch/minor/major  — stable release (npm: latest)"
  echo "  rc/beta/alpha      — pre-release (npm: rc/beta/alpha)"
  echo "  stable             — promote current pre-release to stable (npm: latest)"
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

# Parse current version
BASE_VERSION="${CURRENT%%-*}"
IFS='.' read -r MAJOR MINOR PATCH <<< "$BASE_VERSION"
PRE_TAG=""
PRE_NUM=""

if [[ "$CURRENT" == *"-"* ]]; then
  PRE_PART="${CURRENT#*-}"
  PRE_TAG="${PRE_PART%%.*}"
  PRE_NUM="${PRE_PART#*.}"
fi

# Calculate next version
case "$BUMP" in
  major)
    MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0
    VERSION="${MAJOR}.${MINOR}.${PATCH}"
    ;;
  minor)
    MINOR=$((MINOR + 1)); PATCH=0
    VERSION="${MAJOR}.${MINOR}.${PATCH}"
    ;;
  patch)
    PATCH=$((PATCH + 1))
    VERSION="${MAJOR}.${MINOR}.${PATCH}"
    ;;
  rc|beta|alpha)
    if [[ "$PRE_TAG" == "$BUMP" ]]; then
      # Already on this pre-release channel — bump the number
      PRE_NUM=$((PRE_NUM + 1))
      VERSION="${BASE_VERSION}-${BUMP}.${PRE_NUM}"
    else
      # New pre-release — bump minor and start at .1
      NEW_MINOR=$((MINOR + 1))
      VERSION="${MAJOR}.${NEW_MINOR}.0-${BUMP}.1"
    fi
    ;;
  stable)
    if [[ -z "$PRE_TAG" ]]; then
      echo "Already on a stable version (${CURRENT}). Nothing to promote."
      exit 1
    fi
    VERSION="${BASE_VERSION}"
    ;;
esac

TAG="v${VERSION}"

echo ""
echo "  Release: ${CURRENT} → ${VERSION} (${BUMP})"
echo "  Tag:     ${TAG}"
if [[ "$VERSION" == *"-"* ]]; then
  echo "  Type:    pre-release (npm tag: ${VERSION#*-})"
else
  echo "  Type:    stable (npm tag: latest)"
fi
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

# Generate changelog (optional, skip for pre-releases)
if [[ "$VERSION" != *"-"* ]] && command -v git-cliff >/dev/null 2>&1; then
  git-cliff --tag "$TAG" --unreleased --prepend CHANGELOG.md
elif [[ "$VERSION" == *"-"* ]]; then
  echo "  [info] Skipping changelog for pre-release"
else
  echo "  [warn] git-cliff not found — skipping changelog generation"
fi

# Local verification
echo "  Running local checks..."
pnpm verify || { echo "Verification failed — aborting release"; git checkout package.json CHANGELOG.md 2>/dev/null; exit 1; }

# Commit and tag
git add package.json CHANGELOG.md 2>/dev/null
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
