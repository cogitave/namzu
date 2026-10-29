<!-- okf
type: Reference
title: "@namzu/telemetry"
description: >-
  OpenTelemetry traces, metrics and session export for Namzu. The kernel
  instruments itself and exports nothing; register this once and that
  existing instrumentation starts reaching a collector.
tags: [readme, package, telemetry, observability]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
-->

<div align="center">

<h1>@namzu/telemetry</h1>

**OpenTelemetry traces, metrics and session export for Namzu.**

[![npm](https://img.shields.io/npm/v/@namzu/telemetry.svg)](https://www.npmjs.com/package/@namzu/telemetry)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

The kernel emits spans and metrics through the OpenTelemetry API and exports
nothing on its own. This package is the exporter side: register it once and
the runtime's existing instrumentation starts reaching a collector.

## Install

```bash
pnpm add @namzu/sdk @namzu/telemetry
```

`@namzu/sdk >=44.0.0` is a peer dependency. Install both.

**Compatibility.** `@namzu/telemetry` before 3.0.0 breaks on `@namzu/sdk >=44`,
where the attribute keys were renamed (the run attribute keys became `namzu.turn.*`,
and every span gained `gen_ai.conversation.id`). Use `@namzu/telemetry >=3`.

## Usage

```ts
import { registerTelemetry } from '@namzu/telemetry'

await registerTelemetry({
  serviceName: 'my-agent-host',
  exporterType: 'otlp',
  otlpEndpoint: 'http://localhost:4318',
})
```

`exporterType` remains the fallback for both signals. Set
`traceExporterType` and/or `metricExporterType` to `none`, `console` or `otlp`
to choose independently; for example, `exporterType: 'otlp'` with
`traceExporterType: 'none'` exports metrics only. Custom `spanProcessors` still
run even when the trace exporter is `none`.

The shipped OTLP exporters use HTTP/JSON. Optional `otlpProtocol`,
`traceOtlpProtocol` and `metricOtlpProtocol` accept `http/json`; signal settings
override the general one. Unsupported active OTLP protocols are rejected before
either global provider is registered. Shutdown attempts both pipelines even if
one fails.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
