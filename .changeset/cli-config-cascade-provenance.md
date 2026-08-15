---
'@namzu/cli': minor
---

Add `loadConfigWithProvenance` so the config cascade records which source won each key

`mergeConfigs` used to be `Object.assign` across `DEFAULT_CONFIG`, `~/.namzu/config.yaml`, `namzu.config.json` and the `NAMZU_*` environment scan — the last writer won and nothing recorded who it was. `loadConfigWithProvenance(opts?)` now returns `{ config, provenance }`, where `provenance` maps each key of the resolved config to a `ConfigSource`:

- `{ kind: 'default' }`
- `{ kind: 'user-file', path }`
- `{ kind: 'project-file', path }`
- `{ kind: 'env', variable }` — names the exact `NAMZU_*` variable, not just "env"

A key that no source set is absent from `provenance` entirely — it is never fabricated as `{ kind: 'default' }`, since `DEFAULT_CONFIG` does not carry every field (`sandbox` has none today).

`loadConfig` keeps its exact existing signature, `(opts?: LoadConfigOptions) => NamzuCliConfig` — it is now implemented as `loadConfigWithProvenance(opts).config`, so the two cannot drift apart, and no existing consumer of `loadConfig` sees any behavior change.

New exports from `@namzu/cli`: `loadConfigWithProvenance`, `ConfigProvenance`, `ConfigSource`.

This is groundwork for the CLI's boot narrative (`namzu.config.resolved`), which will use `provenance` to summarize where each setting came from at startup — that rendering is not part of this change.
