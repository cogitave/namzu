---
name: release
description: Use this skill whenever a new version of a package in this monorepo needs to be published to npm. Triggers include "release rc", "cut a patch", "publish <pkg>", "bump sdk", or any phrasing asking for a new version of `@namzu/sdk`, `@namzu/computer-use`, or another publishable workspace. Always use this skill rather than hand-editing `package.json#version` — Changesets owns version state and the Changesets-driven workflow is the only sanctioned publish path.
---

# Release

Cuts new versions of publishable packages via [Changesets](https://github.com/changesets/changesets). Version bumps, CHANGELOG generation, peer-range updates, and npm publish are all driven by the `changesets` CLI plus the `changesets/action@v1` workflow step. No per-package release scripts, no hand-tagged per-package prefixes.

## When to trigger

<triggers>
- User asks to release, publish, cut, bump, or tag a version of a specific workspace package.
- A feature/fix branch is ready to land and needs a changeset declaration so the next auto-release captures it.
- A Changesets-opened "Version Packages" PR needs review + merge to ship.
</triggers>

<not_triggers>
- Just bumping a dependency's version inside the repo (not a release — regular edit).
- Experimentation in a branch that will not be merged.
- A PR that does not affect any publishable package (test-only, docs-only, agents/api/cli-only changes).
</not_triggers>

## The two-phase Changesets flow

<flow>
**Phase 1 — per-PR declaration.** Every PR that touches a publishable package adds a `.changeset/<slug>.md` file declaring bump intent per affected package. Written by the PR author, not auto-derived from commits.

**Phase 2 — auto-release.** On every push to `main`:
- If `.changeset/*.md` files exist → `changesets/action@v1` opens or updates a `chore(release): version packages` PR that bumps versions, updates CHANGELOGs, and widens peer ranges as needed.
- When that PR is merged → the same action runs `pnpm changeset publish`, which publishes every bumped package to npm with provenance and creates GitHub Releases + Git tags.
</flow>

## Steps

### When adding a changeset to a PR (Phase 1)

<procedure_phase_1>
1. From repo root, run:

   ```bash
   pnpm changeset
   ```

2. Interactive prompt: pick the affected packages, pick the bump type per package (`patch` | `minor` | `major`), then write a one-paragraph summary.

3. Commit the generated `.changeset/<slug>.md` file as part of the same PR. No other change is required — versions will be bumped automatically at release time.

4. For BYO / non-interactive workflows, author the `.changeset/<slug>.md` by hand:

   ```md
   ---
   "@namzu/sdk": minor
   "@namzu/bedrock": patch
   ---

   <human-readable summary>
   ```
</procedure_phase_1>

### When shipping a release (Phase 2)

<procedure_phase_2>
1. Confirm the "chore(release): version packages" PR opened by Changesets reflects the expected bumps. Changesets uses the bump intents from all merged `.changeset/*.md` files since the last release.

2. Review the diff. It should include:
   - `package.json#version` bumps for every affected package.
   - Peer range updates where a linked package crossed out of range.
   - CHANGELOG.md updates per affected package.
   - The changeset files themselves being deleted (Changesets consumes them).

3. Verify CI is green on the Version Packages PR. The pre-merge `consumer install`, `publint`, and `@arethetypeswrong/cli` steps in `.github/workflows/ci.yml` catch peer-range drift and package-shape defects before publish.

4. Merge the PR to `main`. The `.github/workflows/release.yml` workflow triggers automatically:
   - Runs the full install + build + lint + typecheck + test pipeline.
   - Runs the pre-publish consumer-install check (`.github/scripts/verify-consumer-install.sh`) against the packed tarballs.
   - Invokes `pnpm changeset publish` — publishes every bumped package to npm with provenance, creates Git tags (`@namzu/<pkg>@<version>`), and GitHub Releases.

5. Monitor `https://github.com/cogitave/namzu/actions` for the release run. Confirm each published package appears on npm under its expected dist-tag.
</procedure_phase_2>

## Hard rules

<hard_rules>
- Never hand-edit `package.json#version`. Changesets owns version state.
- Never invoke `npm publish` or `pnpm publish` directly. The release workflow is the authority, and it runs `changeset publish`.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) during a release commit.
- Never merge a "Version Packages" PR if CI is red on it — the red gate is catching a real publish-time regression.
- Peer range widening / narrowing happens via Changesets config (`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange`). Do not hand-edit peer ranges in `package.json` files unless the change is a policy decision being ratified in a session (e.g., the original `>=0.1.6 <1.0.0` policy set in ses_012).
- NPM Trusted Publisher is configured via OIDC (provenance). Do not add an `NPM_TOKEN` secret unless switching to classic auth.
</hard_rules>

## Config

<config>
- `.changeset/config.json` — Changesets configuration.
  - `access: "public"` — all Namzu packages are public scope.
  - `updateInternalDependencies: "patch"` — when an internal dep bumps, dependents patch-bump.
  - `ignore: ["@namzu/agents", "@namzu/api", "@namzu/cli"]` — gitignored workspace packages never published.
  - `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true` — peer dependents only bump when the peer range would otherwise exclude the new version. Avoids unnecessary provider major-bumps on SDK minor releases.
- `.github/workflows/release.yml` — the single unified release workflow.
- `.github/scripts/verify-consumer-install.sh` — pre-publish tarball sanity check; also invoked from `ci.yml` on every PR.
- Package peer ranges — convention is `">=<lower> <1.0.0"` for pre-1.0 SDK (see ses_012-bedrock-integration-feedback).
</config>

## Output

- List of changeset files added (Phase 1) or packages bumped + tags cut (Phase 2).
- Workflow URL (if observable).
- Final dist-tag published under on npm.
- Progress log entry if inside a session.
