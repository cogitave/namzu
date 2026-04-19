---
name: release
description: Use this skill whenever a new version of a package in this monorepo needs to be published to npm. Triggers include "release rc", "cut a patch", "publish <pkg>", "bump sdk", or any phrasing asking for a new version of `@namzu/sdk`, `@namzu/computer-use`, or another per-package publishable workspace. Always use this skill rather than hand-editing `package.json#version` — the per-package tag prefix drives the GitHub Actions publisher, and bypassing the script breaks the release contract.
---

# Release

Cuts a new version of a publishable package in this monorepo. Version bumps are driven by a per-package `release:*` script that bumps the version, commits, tags with the correct prefix, and pushes. A matching GitHub Actions workflow then publishes to npm with the correct dist-tag.

## When to trigger

<triggers>
- User asks to release, publish, cut, bump, or tag a version of a specific workspace package.
- Changelog entries or final commits for a release train are ready.
- A hotfix has been merged and needs a patch release.
</triggers>

<not_triggers>
- Just bumping a dependency's version inside the repo (not a release — regular edit).
- Experimentation in a branch that will not be published.
</not_triggers>

## Steps

<procedure>
1. Confirm which package is being released and which bump type applies:

   <bump_types>
     - `rc` — release candidate, dist-tag `rc`.
     - `beta` — prerelease, dist-tag `beta`.
     - `patch` / `minor` / `major` — stable, dist-tag `latest`.
     - `stable` — promote a prerelease to stable with the same base version.
   </bump_types>

2. Verify working tree is clean and on the intended branch. Do not release from a dirty tree.

3. Verify git identity: `git config --show-origin user.email` must resolve to the required author. If it does not, correct the local identity before continuing (see skill: `commit`).

4. Run the per-package script from the repo root using pnpm filter:

   ```bash
   pnpm --filter <package-name> release:<bump-type>
   ```

   Examples:
   - `pnpm --filter @namzu/sdk release:rc`
   - `pnpm --filter @namzu/computer-use release:patch`

5. The script performs the following atomically:
   - Bumps `package.json#version`.
   - Creates a commit for the bump.
   - Tags the commit with the package-prefixed tag (e.g. `sdk-v1.4.0-rc.2`, `computer-use-v0.3.1`).
   - Pushes commit and tag to the remote.

6. Monitor the corresponding GitHub Actions workflow:
   - `sdk-v*` → `.github/workflows/release-sdk.yml`.
   - `computer-use-v*` → `.github/workflows/release-computer-use.yml`.
   The workflow resolves dist-tag from the version string and publishes via NPM Trusted Publisher.

7. After publish succeeds, confirm on npm that the version is visible under the expected dist-tag.
</procedure>

## Hard rules

<hard_rules>
- Never hand-edit `package.json#version`. The script owns version state.
- Never publish manually with `npm publish`. The GitHub Actions workflow is the authority.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) during a release commit.
- Never push without explicit user approval if this is the first release of a new package. Confirm visibility and registry config before proceeding.
- NPM Trusted Publisher is configured for `@namzu/sdk` and `@namzu/computer-use` — no `NPM_TOKEN` should be added.
</hard_rules>

## Output

- Package released + version cut.
- Tag name pushed.
- Workflow URL (if observable).
- Final dist-tag published under on npm.
- Progress log entry if inside a session.
