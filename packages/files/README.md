<!-- okf
type: Reference
title: "@namzu/files"
description: >-
  File registry and blob-store contracts for Namzu runtimes. Two contracts
  with different lifetimes, three backends behind subpath exports, and an
  HTTP router that checks containment before it serves a download.
tags: [readme, package, files, storage]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/files</h1>

**File registry and blob storage for Namzu runs.**

[![npm](https://img.shields.io/npm/v/@namzu/files.svg)](https://www.npmjs.com/package/@namzu/files)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

A message that carries a screenshot carries it forever — into the
transcript, into the store, and back to the provider on every subsequent
turn. This package gives those bytes an identity and a scope, so the message
carries a reference instead.

## Install

```bash
pnpm add @namzu/files
```

No peer dependency on the kernel — the contracts stand alone.

## Usage

```ts
import { isSafeRelativePath } from '@namzu/files'
```

## Documentation

- [The file registry — contracts, backends and the HTTP surface](https://github.com/cogitave/namzu/blob/main/docs/packages/files.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
