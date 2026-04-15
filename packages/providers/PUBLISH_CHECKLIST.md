# Provider Packages — Publish Checklist

Follow this runbook once per new `@namzu/<vendor>` package **before** the first tag-triggered CI release. Bootstraps npm registration + Trusted Publisher so subsequent releases run through `.github/workflows/release-<vendor>.yml` with provenance.

## Per-package order

For each package, in order: `bedrock` → `openrouter` → `ollama` → `lmstudio` → `http` → `openai` → `anthropic`.

### 1. Placeholder publish (reserve npm name; no provenance)

```bash
cd packages/providers/<vendor>
```

Temporarily edit `package.json`:

- `version`: `"0.1.0"` → `"0.0.1"`
- `publishConfig.provenance`: `true` → `false`

```bash
pnpm build
pnpm publish --access public --no-git-checks
# OTP prompted in browser / authenticator
```

Restore `package.json`:

- `version` → `"0.1.0"`
- `publishConfig.provenance` → `true`

Do NOT commit the temporary edits — working tree must be clean before proceeding.

### 2. Configure Trusted Publisher

```bash
npm trust github @namzu/<vendor> \
  --file=release-<vendor>.yml \
  --repository=cogitave/namzu \
  --yes
# OTP prompted
```

Verify:

```bash
npm trust list @namzu/<vendor>
# Expected: type: github, file: release-<vendor>.yml, repository: cogitave/namzu
```

### 3. First real release via CI (provenance'd)

Current package.json is at `0.1.0`. Tag directly (skip release.sh which would bump to 0.1.1):

```bash
cd /Users/arda/Documents/Workspaces/@self/namzu
git tag -a <vendor>-v0.1.0 -m "Release @namzu/<vendor> 0.1.0"
git push origin <vendor>-v0.1.0
```

CI workflow `release-<vendor>.yml` triggers, publishes `@namzu/<vendor>@0.1.0` with `--provenance` under dist-tag `latest`.

Verify post-release:

```bash
npm view @namzu/<vendor> dist-tags
# Expected: { latest: '0.1.0' }
# (0.0.1 still exists as the placeholder; acceptable.)
```

Create GitHub Release manually if the workflow's release creation step fails from race conditions (see I.10 phase notes on parallel release race).

## Per-vendor status

| Package | Placeholder published | Trusted Publisher | 0.1.0 tag released |
|---------|----------------------|-------------------|--------------------|
| `@namzu/bedrock` | ⏸ batched | ⏸ batched | ⏸ batched |
| `@namzu/openrouter` | ⏸ batched | ⏸ batched | ⏸ batched |
| `@namzu/ollama` | ⏸ batched | ⏸ batched | ⏸ batched |
| `@namzu/lmstudio` | ⏸ batched | ⏸ batched | ⏸ batched |
| `@namzu/http` | ⏸ batched | ⏸ batched | ⏸ batched |
| `@namzu/openai` | ⏸ batched | ⏸ batched | ⏸ batched |
| `@namzu/anthropic` | ⏸ batched | ⏸ batched | ⏸ batched |

All packages are **implemented + tested + committed** but not yet published. The publish round runs as Phase I.10 (coordinated release) per ADR-0001.

## Notes

- `@namzu/sdk@1.0.0` major bump must land at the tail of I.10 so provider peer ranges (`^1 || ^0.1.6`) keep working during the transition window.
- Migration guide in `@namzu/sdk@1.0.0` README + CHANGELOG points to each provider package.
- `0.1.x` sdk line receives security backports through 2026-10-15 (per ADR §Support Policy), EOL thereafter.
- OTel observability stripped for v0.1.0 of each provider. Returns via future `@namzu/telemetry` package.
