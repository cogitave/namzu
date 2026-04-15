# Changelog

All notable changes to `@namzu/bedrock` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. BedrockProvider extracted from @namzu/sdk core per ADR-0001.
- Converse API (chat + chatStream) with tool-use support.
- `registerBedrock()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.

### Changed

- Observability (OTEL spans, structured logging) removed pending @namzu/telemetry package.
