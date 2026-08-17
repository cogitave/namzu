<!-- okf
type: Reference
title: "@namzu/files"
description: >-
  File registry and blob-store contracts for Namzu runtimes, with in-memory,
  local-disk and Azure Blob backends and an HTTP router. A run's attachments
  get an identity and a scope instead of being carried as bytes in a message.
tags: [readme, package, files, storage]
timestamp: 2026-08-17T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/files</h1>

**File registry contracts for [`@namzu/sdk`](https://www.npmjs.com/package/@namzu/sdk).**

[![License: FSL-1.1-MIT](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)
[![npm](https://img.shields.io/npm/v/@namzu/files.svg?label=%40namzu%2Ffiles)](https://www.npmjs.com/package/@namzu/files)

[Install](#install) · [The two contracts](#the-two-contracts) · [Backends](#backends) · [HTTP](#http) · [Status](#status)

</div>

---

## What this is

A message that carries a screenshot carries it forever: into the transcript,
into the store, and back to the provider on every subsequent turn. A file
registry is the alternative — the bytes go somewhere with an identity, and the
message carries a reference.

This package is the contracts for that, plus the backends that implement them.
It is separate from the kernel because the kernel needs the *shape* of a file
reference, not a storage client.

## Install

```bash
pnpm add @namzu/files
```

No peer dependency on the kernel: the contracts stand alone, and a host can
implement `BlobStore` against its own storage without either package.

## The two contracts

**`BlobStore`** is bytes: put, get, delete, addressed by a `StorageRef`. It
knows nothing about who owns the bytes or why.

**`FileRegistry`** is the record: a `FileRecord` with an id, a `FileScope`
(tenant, project, session, run, message, …), a `FileRole` (`input`, `output`,
`artifact`, `attachment`, …) and a `FileSource`. It is what makes "every file
this run produced" answerable, and what a retention policy acts on.

They are separate because they have different lifetimes. Deleting a run's
records does not necessarily delete the bytes, and a blob may be referenced by
more than one record.

```ts
import { isSafeRelativePath } from '@namzu/files'
```

`isSafeRelativePath` is the containment predicate the backends share — a
storage key derived from a caller-supplied name has to stay inside its root,
and one function deciding that for every backend beats each one having its own
opinion.

## Backends

Each is a subpath, so a consumer installs the SDK for the one they use and
carries no client for the others.

| Subpath | Export | For |
|---|---|---|
| `@namzu/files/inmem` | `InMemoryBlobStore` | tests, and a dev loop with nothing to configure |
| `@namzu/files/local` | `LocalFsBlobStore` | a single machine writing under one root |
| `@namzu/files/azure-blob` | `AzureBlobStore` | Azure Blob Storage |

```ts
import { LocalFsBlobStore } from '@namzu/files/local'

const store = new LocalFsBlobStore({ root: '/var/lib/namzu/blobs' })
```

## HTTP

```ts
import { createFilesRouter, DEFAULT_DOWNLOAD_PATH_ROOTS } from '@namzu/files/http'
```

`createFilesRouter` returns the route handlers for listing, uploading and
downloading files over HTTP, given a registry and a store.
`DEFAULT_DOWNLOAD_PATH_ROOTS` is the allowed set of download roots, and
`isPathWithinRoots` is the check applied to every requested path — a download
endpoint that resolves a caller-supplied path without one is a directory
traversal.

## Status

Pre-1.0. The three backends above are what ships; `StorageProviderId` names
others that are contract-level identifiers rather than implementations in this
package.

## License

FSL-1.1-MIT, converting to MIT two years after each release. Same as
`@namzu/sdk`.
