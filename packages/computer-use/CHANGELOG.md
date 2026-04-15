# Changelog

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
