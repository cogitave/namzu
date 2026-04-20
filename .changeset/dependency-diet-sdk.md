---
"@namzu/sdk": minor
---

**BREAKING**: OpenTelemetry SDK and exporters extracted to `@namzu/telemetry`. `zod` and `zod-to-json-schema` moved to `peerDependencies`. `@opentelemetry/api` moved to `peerDependencies`.

All removed exports have a replacement in `@namzu/telemetry`:

| Removed | Import from `@namzu/telemetry` |
| --- | --- |
| `TelemetryProvider` | `TelemetryProvider` |
| `initTelemetry` (sync) | `registerTelemetry` (async — **await it**) |
| `getTelemetry`, `getTracer`, `getMeter` | same names |
| `createPlatformMetrics`, `PlatformMetrics` | same names |
| `TelemetryConfig`, `ExporterType` | same names |
| `GENAI`, `NAMZU`, span-name helpers | `@namzu/telemetry/attributes` subpath |

Install-surface delta: `@namzu/sdk` runtime deps 10 → 0. Consumers who don't emit telemetry and don't use Zod directly install 0 extra packages from the SDK tree. See [`docs/migration/0.4.md`](https://github.com/cogitave/namzu/blob/main/docs/migration/0.4.md) for the full upgrade path.

Related: `@namzu/telemetry@0.1.0` initial publish ships in the same release.
