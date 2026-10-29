---
type: Reference
title: Sending spans and metrics to a collector
description: Opt in with NAMZU_ENABLE_TELEMETRY or telemetry.otlp and the CLI sends the kernel's spans and metrics to an OpenTelemetry collector.
resource: packages/cli/src/integrations/telemetry/otlp-export.ts
tags: [cli, telemetry, opentelemetry, observability]
status: stable
---

# Sending spans and metrics to a collector

The kernel records a span for each turn, model call and tool call, and
metrics for tokens, cost and duration. By default nothing leaves the machine.
Turn the export on and the CLI sends them to an OpenTelemetry collector over
OTLP/HTTP with JSON encoding. Spans carry timings, counts and names, plus the conversation id and the
error text of a failed tool call. That text can contain a command line, a file
path or a fragment of output. No prompt or reply is attached.

## Turning it on

Either set the switch in the environment:

```sh
NAMZU_ENABLE_TELEMETRY=1 \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer%20token" \
namzu
```

or write it in a config file, which wins over the environment:

```yaml
telemetry:
  otlp:
    endpoint: http://localhost:4318
    headers:
      authorization: Bearer token
```

A collector address on its own does not turn anything on. With no endpoint the
exporter uses its default, `http://localhost:4318`. Namzu adds `/v1/traces`
and `/v1/metrics` to the address; per-signal addresses are not read.

| Variable | Meaning |
| --- | --- |
| `NAMZU_ENABLE_TELEMETRY` | `1`, `true`, `yes` or `on` turns the export on. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Collector address. |
| `OTEL_EXPORTER_OTLP_HEADERS` | `name=value` pairs separated by commas, values percent-decoded. |
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | Each independently selects `otlp` (default), `console` (terminal) or `none` (disabled). Disabling traces does not disable metrics, and vice versa; `console` for one signal does not redirect the other. Both `none` skips loading exporters entirely. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` (default). `grpc` and `http/protobuf` are not shipped; an active OTLP signal requesting either is reported as unsupported rather than silently using another transport. |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` | Per-signal protocol overrides the general protocol. Ignored when that signal is `none` or `console`. |

## When it cannot start

If `@namzu/telemetry` is not installed or fails to load, Namzu logs a warning
and carries on without the export. This differs from `telemetry.sessionExport`,
which refuses to run because a recorded conversation is something its owner is
counting on.

Queued data is sent when the command finishes. Both signal pipelines are shut
down even if one exporter's shutdown fails. An unsupported exporter or active
OTLP protocol logs a warning and skips registration, with no partially started
pipeline or network export.
