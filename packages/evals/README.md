<!-- okf
type: Reference
title: "@namzu/evals"
description: >-
  Namzu's own behaviour and security suites, runnable with `namzu eval`.
  Nothing here measures a model — a score that moves means the code changed,
  not that a vendor did.
tags: [readme, package, evals, testing]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-17T00:00:00Z }
-->

<div align="center">

<h1>@namzu/evals</h1>

**Behaviour and security suites for [Namzu](https://github.com/cogitave/namzu).**

[![npm](https://img.shields.io/npm/v/@namzu/evals.svg)](https://www.npmjs.com/package/@namzu/evals)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Namzu's own behaviour and security suites, runnable against an installed
kernel. Nothing here measures a model: the kernel suites run a scripted
provider and the security suites touch none, so a score that moves means the
code changed.

## Install

```bash
pnpm add -D @namzu/cli @namzu/evals
```

## Usage

```bash
pnpm exec namzu eval --dir node_modules/@namzu/evals --out eval-report.json
```

The kernel suites drive a scripted provider and the security suites touch no
provider at all, so both are deterministic and cost nothing to run.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
