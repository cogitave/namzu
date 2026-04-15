# Changelog

All notable changes to `@namzu/http` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-15

### Added

- Initial release. Zero-dependency LLM provider for any OpenAI- or Anthropic-compatible HTTP endpoint.
- `HttpProvider` implements `LLMProvider` (chat + chatStream).
- `dialect` parameter: `'openai'` (default) for OpenAI-compat endpoints (Ollama, LM Studio, vLLM, Groq, etc.) or `'anthropic'` for native Anthropic Messages API.
- `registerHttp()` helper for one-call provider registration.
- Module augmentation of @namzu/sdk's ProviderConfigRegistry for type-safe config.
- `DialectMismatchError` thrown on response-shape mismatch (actionable error with URL + status + sample).

### Changed

- Observability (OTEL spans, structured logging) excluded pending @namzu/telemetry package.
