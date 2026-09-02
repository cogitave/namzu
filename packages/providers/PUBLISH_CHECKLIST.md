# Provider packages — release checklist

Provider packages use the repository-wide Changesets release path. There are
no per-provider release workflows, tag-triggered publishes, placeholder
versions or direct maintainer publishes. The authoritative workflow is
`.github/workflows/release.yml`.

## Add or change a provider

1. Keep the package under `packages/providers/<name>` with publish metadata,
   README, tests and a concept page under `docs/` when the driver has a surface worth documenting.
2. Add or update a Changeset. Its bump describes consumer impact; do not edit
   `package.json#version` or a changelog by hand.
3. If this is a new provider, update the root package table, the SDK README and
   architecture provider inventory.
4. Run the repository gates, including publish metadata, the packed consumer
   install check and `publint` against the exact provider package.
5. Merge through the ordinary reviewed path. A direct push does not create a
   separate provider release channel.

## Version and publish

After Changesets reach `main`, the release automation opens or refreshes the
version PR. Before merging it:

1. Confirm every Changeset currently on `main` appears among the PR's deleted
   files. A missing file means the version snapshot is stale.
2. Confirm the generated versions and changelog entries match the declared
   bump intent.
3. Let the version PR run the full pull-request gate suite.
4. Merge the version PR. The unified workflow runs the parity-defined
   direct-`main` validation subset (with the repository's named cost
   exemptions), then publishes with
   `pnpm changeset publish` and package provenance enabled by each manifest.

A green workflow is not registry evidence. Confirm the exact package and
version after publish:

```bash
npm view @namzu/<provider> version
npm view @namzu/<provider> dist-tags --json
```

Match the workflow SHA to the version commit before calling the release
complete. If the registry does not report the generated version, diagnose the
publish step; do not spend another version number as a substitute for finding
the failure.

## Never

- Do not invoke `npm publish` or `pnpm publish` directly.
- Do not create a provider-specific release tag or workflow.
- Do not disable provenance to reserve a package name.
- Do not merge a version PR that leaves a Changeset behind.
