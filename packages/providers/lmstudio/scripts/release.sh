#!/usr/bin/env bash
set -euo pipefail

# @namzu/lmstudio Release Script (local orchestration)
#
# Usage:
#   Stable releases:
#     ./scripts/release.sh patch                # 0.1.3 → 0.1.4
#     ./scripts/release.sh minor                # 0.1.3 → 0.2.0
#     ./scripts/release.sh major                # 0.1.3 → 1.0.0
#
#   Pre-releases (explicit bump required):
#     ./scripts/release.sh rc patch             # 0.1.3 → 0.1.4-rc.1
#     ./scripts/release.sh rc minor             # 0.1.3 → 0.2.0-rc.1
#     ./scripts/release.sh rc                   # 0.1.4-rc.1 → 0.1.4-rc.2 (bump counter)
#     ./scripts/release.sh beta patch           # 0.1.3 → 0.1.4-beta.1
#     ./scripts/release.sh alpha minor          # 0.1.3 → 0.2.0-alpha.1
#
#   Promote to stable:
#     ./scripts/release.sh stable               # 0.1.4-rc.2 → 0.1.4
#
#   Dry run:
#     ./scripts/release.sh patch --dry-run
#     ./scripts/release.sh rc patch --dry-run
#
# What happens locally:
#   1. Validates clean working tree + main branch
#   2. Bumps version in package.json
#   3. Generates CHANGELOG.md via git-cliff (stable only, if available)
#   4. Runs local verification (lint + typecheck + build + test)
#   5. Commits, tags, pushes
#
# What happens on GitHub (release.yml):
#   - Detects stable vs pre-release from version string
#   - Publishes to npm with correct dist-tag (latest / rc / beta / alpha)
#   - Creates GitHub Release (pre-release flag for non-stable)
#
# Prerequisites: jq, git-cliff (optional)

CHANNEL="${1:-}"
BUMP="${2:-}"
DRY_RUN=""

# Parse args
if [[ "$CHANNEL" == "--dry-run" ]] || [[ "$BUMP" == "--dry-run" ]] || [[ "${3:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
fi

if [[ -z "$CHANNEL" ]]; then
  echo "Usage: ./scripts/release.sh <patch|minor|major|rc|beta|alpha|stable> [patch|minor|major] [--dry-run]"
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
  # Strip any non-digit suffix (e.g. `1-fix` from corruption-remediation tags → `1`)
  PRE_NUM="${PRE_NUM%%[!0-9]*}"
fi

# Calculate next version
case "$CHANNEL" in
  patch|minor|major)
    # Stable release
    case "$CHANNEL" in
      major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
      minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
      patch) PATCH=$((PATCH + 1)) ;;
    esac
    VERSION="${MAJOR}.${MINOR}.${PATCH}"
    ;;

  rc|beta|alpha)
    if [[ "$PRE_TAG" == "$CHANNEL" ]]; then
      # Already on this channel → bump counter
      PRE_NUM=$((PRE_NUM + 1))
      VERSION="${BASE_VERSION}-${CHANNEL}.${PRE_NUM}"
    elif [[ -z "$BUMP" ]] || [[ "$BUMP" == "--dry-run" ]]; then
      echo "Error: First pre-release requires a bump level."
      echo "Usage: ./scripts/release.sh $CHANNEL <patch|minor|major>"
      echo ""
      echo "Example: ./scripts/release.sh $CHANNEL patch   # ${CURRENT} → $((PATCH + 1))-${CHANNEL}.1"
      exit 1
    else
      # New pre-release with explicit bump
      case "$BUMP" in
        major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
        minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
        patch) PATCH=$((PATCH + 1)) ;;
        *) echo "Invalid bump level: $BUMP (use patch, minor, or major)"; exit 1 ;;
      esac
      VERSION="${MAJOR}.${MINOR}.${PATCH}-${CHANNEL}.1"
    fi
    ;;

  stable)
    if [[ -z "$PRE_TAG" ]]; then
      echo "Already on a stable version (${CURRENT}). Nothing to promote."
      exit 1
    fi
    VERSION="${BASE_VERSION}"
    ;;

  *)
    echo "Unknown channel: $CHANNEL"
    echo "Usage: ./scripts/release.sh <patch|minor|major|rc|beta|alpha|stable> [patch|minor|major] [--dry-run]"
    exit 1
    ;;
esac

TAG="lmstudio-v${VERSION}"

echo ""
echo "  Release: ${CURRENT} → ${VERSION}"
echo "  Tag:     ${TAG}"
if [[ "$VERSION" == *"-"* ]]; then
  PRE_CHANNEL="${VERSION#*-}"
  PRE_CHANNEL="${PRE_CHANNEL%%.*}"
  echo "  Channel: ${PRE_CHANNEL} (npm tag: ${PRE_CHANNEL})"
else
  echo "  Channel: stable (npm tag: latest)"
fi
echo ""

if [[ -n "$DRY_RUN" ]]; then
  if command -v git-cliff >/dev/null 2>&1 && [[ "$VERSION" != *"-"* ]]; then
    echo "  [dry-run] Changelog preview:"
    git-cliff --tag "$TAG" --unreleased --strip header
  fi
  echo "  [dry-run] No changes made."
  exit 0
fi

# Bump version
TMPFILE=$(mktemp)
jq ".version = \"${VERSION}\"" package.json > "$TMPFILE" && mv "$TMPFILE" package.json

# Generate changelog (stable only)
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
git commit -m "chore(release): lmstudio ${VERSION}"
git tag -a "$TAG" -m "Release @namzu/lmstudio ${VERSION}"

echo ""
echo "  Pushing to origin..."
git push origin main
git push origin "$TAG"

echo ""
echo "  Done! Tag ${TAG} pushed."
echo "  GitHub Actions will now: build → test → npm publish → create release."
echo "  Track: https://github.com/cogitave/namzu/actions"
echo ""
