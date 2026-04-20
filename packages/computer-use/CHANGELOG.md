# Changelog

## 0.2.0

### Minor Changes

- 40eb841: Move `@namzu/sdk` from `dependencies` to `peerDependencies`.

  Previously, `@namzu/computer-use@0.1.0` declared `@namzu/sdk` as a direct runtime dependency (`workspace:^`), which meant a consumer installing both packages would end up with **two concurrent copies of `@namzu/sdk`** in `node_modules` — the one they installed themselves and the one computer-use resolved. This produces symbol-identity bugs (two separate `AgentManager` classes, two separate `RunEvent` schemas, etc.) that surface as hard-to-diagnose "instanceof fails" at runtime.

  The correct shape, matching the 7 provider packages, is peer + dev:

  - `peerDependencies`: `@namzu/sdk: ">=0.1.6 <1.0.0"` — consumer provides, resolved once.
  - `devDependencies`: `@namzu/sdk: workspace:^` — for local dev and type-checking.

  **Consumer migration:** if you previously relied on `@namzu/computer-use` pulling `@namzu/sdk` in transitively, install it explicitly:

  ```
  npm install @namzu/sdk @namzu/computer-use
  ```

  This is technically a breaking change (the transitive resolution no longer works), but pre-1.0 SDK context and the runtime-corruption risk of the old shape justify correcting it as a minor bump.

All notable changes to `@namzu/computer-use` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Changed

- First stable release from the `cogitave/namzu` monorepo. Ships with the full subprocess computer-use host from 0.0.1; package is now published under the `latest` dist-tag with full provenance attestations.
- Released via tag-prefix scheme: `computer-use-v*` triggers `.github/workflows/release-computer-use.yml`.

## [0.0.2-rc.1]

### Changed

- Pre-release smoke test for the new monorepo release pipeline. Verified `npm trust`-based provenance publishing end-to-end. Functionally identical to `0.0.1`.

## [0.0.1]

### Added

- Initial release. `SubprocessComputerUseHost` implementing `ComputerUseHost` from `@namzu/sdk`.
- Platform adapters: `darwin`, `linux-x11`, `linux-wayland`, `win32`.
- Capability probe per adapter with honest degradation (missing binaries → `AdapterUnavailableError` at construction; missing optional deps → capability flag false).
- Display-server detection via `process.platform` + `XDG_SESSION_TYPE` / `WAYLAND_DISPLAY` / `DISPLAY`.
- Unit test coverage for key-combo translation across adapters and display-server detection.
