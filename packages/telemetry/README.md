<!-- okf
type: Reference
title: "@namzu/telemetry"
description: >-
  OpenTelemetry traces, metrics and session export for Namzu. The kernel
  instruments itself and exports nothing; register this once and that
  existing instrumentation starts reaching a collector.
tags: [readme, package, telemetry, observability]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
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

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { registerTelemetry } from '@namzu/telemetry'

await registerTelemetry({
  serviceName: 'my-agent-host',
  exporterType: 'otlp',
  otlpEndpoint: 'http://localhost:4318',
})
```

## Documentation

- [Telemetry — registering a provider, exporters, metrics and session export](https://github.com/cogitave/namzu/blob/main/docs/packages/telemetry.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
