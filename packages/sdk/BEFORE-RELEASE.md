# Before Release Checklist

Run this checklist before every version bump and publish. Do not skip any item.

## Security

- [ ] No API keys, tokens, or secrets in source code (`grep -rn "sk-\|ghp_\|AKIA\|eyJ" src/`)
- [ ] No credentials in config files, docs, or scripts
- [ ] No `.env` files tracked by git (`git ls-files | grep -i env`)
- [ ] No private keys or certificates in the repository
- [ ] `.gitignore` covers: `.env`, `.env.*`, `*.pem`, `*.key`

## Version Consistency

- [ ] `package.json` version is bumped correctly (semver)
- [ ] `CHANGELOG.md` reflects the new version's changes
- [ ] No hardcoded version strings in source — all use `VERSION` from `version.ts`
- [ ] Pre-release versions use correct format: `X.Y.Z-rc.N`

## Build Integrity

- [ ] `pnpm build` — zero errors
- [ ] `pnpm lint` — zero errors
- [ ] `pnpm typecheck` — zero errors
- [ ] `pnpm test` — all tests pass
- [ ] Lockfile is up to date (`pnpm install --frozen-lockfile` succeeds)

## npm Package Contents

- [ ] `package.json#files` includes only intended files (`dist`, `src`, `LICENSE.md`, `README.md`, `CHANGELOG.md`)
- [ ] No test files, docs.local, or internal configs in the published package
- [ ] `npm pack --dry-run` shows expected contents
- [ ] Package name is `@namzu/sdk` — not changed accidentally

## GitHub

- [ ] Trusted Publisher configured on npmjs.com for `release.yml`
- [ ] `release.yml` workflow is valid and targets the correct registry
- [ ] Working tree is clean before tagging
- [ ] Tag follows `vX.Y.Z` format

## Post-Release Verification

- [ ] npm package page shows correct version: https://www.npmjs.com/package/@namzu/sdk
- [ ] `npm install @namzu/sdk@latest` installs the new version
- [ ] GitHub Release created with correct tag and notes
- [ ] CI passed on the release workflow
