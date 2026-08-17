<!-- okf
type: Reference
title: "@namzu/lsp"
description: >-
  Language-server-backed code navigation for Namzu agents. Definitions,
  references, symbols and diagnostics from a real server rather than from
  grep, with one server per language routed by file extension.
tags: [readme, package, lsp, code-navigation]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/lsp</h1>

**Language-server-backed code navigation for Namzu agents.**

[![npm](https://img.shields.io/npm/v/@namzu/lsp.svg)](https://www.npmjs.com/package/@namzu/lsp)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Code navigation for an agent — definitions, references, symbols and
diagnostics — served by a real language server rather than by grep. One
server per language, routed by file extension, disposed with the run.

## Install

```bash
pnpm add @namzu/sdk @namzu/lsp
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { RoutingCodeNavigationProvider } from '@namzu/lsp'
import { getCodeNavigationTools, ToolRegistry } from '@namzu/sdk'

const rootDir = process.cwd()

const codeNavigation = new RoutingCodeNavigationProvider({
  routes: [
    { extensions: ['.ts', '.tsx'], server: { command: 'ts-server', args: ['--stdio'], rootDir } },
    { extensions: ['.py'], server: { command: 'py-server', rootDir } },
  ],
})

const registry = new ToolRegistry()
for (const tool of getCodeNavigationTools(codeNavigation)) registry.register(tool)

// …and when the run is over:
await codeNavigation.dispose()
```

## Documentation

- [Code navigation — routing, the four operations and containment](https://github.com/cogitave/namzu/blob/main/docs/packages/lsp.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
