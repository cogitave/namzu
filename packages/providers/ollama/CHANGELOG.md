# Changelog

All notable changes to `@namzu/ollama` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. Local-first LLM support via the official `ollama` npm client.
- `OllamaProvider` implements `LLMProvider` (chat + chatStream).
- `registerOllama()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- Default host: `http://localhost:11434` (configurable via `host` option or `OLLAMA_HOST` env var).

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
