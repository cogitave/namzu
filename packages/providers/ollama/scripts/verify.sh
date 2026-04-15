#!/usr/bin/env bash
set -euo pipefail

# Namzu Verification Script
# Runs all checks in the correct order. Use before committing.

echo "  [1/4] Lint..."
pnpm lint

echo "  [2/4] Typecheck..."
pnpm typecheck

echo "  [3/4] Build..."
pnpm build

echo "  [4/4] Test..."
pnpm test

echo ""
echo "  All checks passed."
