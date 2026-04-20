# Changelog

## 0.1.1

### Patch Changes

- 40eb841: Widen `@namzu/sdk` peer range to `>=0.1.6 <1.0.0`.

  The previous peer range `^1 || ^0.1.6` resolved to `>=0.1.6 <0.2.0 || >=1.0.0`, which excluded the published `@namzu/sdk@0.2.0` and caused `npm install @namzu/sdk @namzu/<provider>` to fail with ERESOLVE on a clean machine. The new range covers every pre-1.0 SDK minor from 0.1.6 onward; the 1.0 pledge will be the next explicit widening.

  This is the first release under the new Changesets-driven workflow and the wide-pre-1.0-peer convention. Consumers who followed the README's "getting started" install were previously blocked; after this release `npm install @namzu/sdk@latest @namzu/<provider>@latest` resolves cleanly.

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
