# Changelog

All notable changes to `@namzu/anthropic` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. Anthropic support via the official `@anthropic-ai/sdk`.
- `AnthropicProvider` implements `LLMProvider` (chat + chatStream).
- `registerAnthropic()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- Messages API with tool-use support.

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
