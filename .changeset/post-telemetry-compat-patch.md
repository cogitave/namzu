---
"@namzu/sdk": patch
"@namzu/telemetry": patch
"@namzu/computer-use": patch
"@namzu/anthropic": patch
"@namzu/bedrock": patch
"@namzu/http": patch
"@namzu/lmstudio": patch
"@namzu/ollama": patch
"@namzu/openai": patch
"@namzu/openrouter": patch
---

Coordinated patch bump across all publishable packages after the `@namzu/telemetry@0.1.0` extraction landed. No functional changes — this is a compatibility and release-pipeline validation cut to (a) exercise the Trusted Publisher binding for `@namzu/telemetry` that was configured after the 0.1.0 bootstrap publish, and (b) give consumers a single aligned set of patch versions that all know about the new telemetry package.

Resulting versions:

- `@namzu/sdk` → `0.4.1`
- `@namzu/telemetry` → `0.1.1`
- `@namzu/computer-use` → `0.2.1`
- `@namzu/anthropic`, `@namzu/bedrock`, `@namzu/http`, `@namzu/lmstudio`, `@namzu/ollama`, `@namzu/openai`, `@namzu/openrouter` → `0.1.2`
