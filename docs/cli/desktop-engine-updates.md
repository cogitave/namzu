---
type: Design
title: Desktop engine updates (core)
description: How Namzu Desktop will keep its engine current without an installer - the signed description, the archive reader, the folder it keeps, how it chooses and goes back - and what the first part of that, which is inert, contains.
resource: packages/desktop/src/main/kernel/
tags: [desktop, engine, updates, trust]
status: draft
generated:
  by: namzu/desktop-engine-updates
  at: 2026-11-12
---

# Desktop engine updates (core)

Namzu Desktop starts its host from a copy of the command line that was put inside the installer.
The command line and its engine are released several times a day; the installer rarely. The app
is meant to keep its engine current by itself, in the background, without asking: a signed
description of the newest engine, one archive per platform, verification before anything runs,
effect at the next project open, two versions kept, and the copy inside the installer as the
fallback that always works.

This page describes the first part: the core under `packages/desktop/src/main/kernel/`, which has
no Electron in it and no caller yet. Every outside effect (the network, the clock, the file
system, the self-check) is passed in. **The whole feature is inert**: the list of compiled public
keys (`KERNEL_PUBLIC_KEYS`) is empty, and with an empty list no request is made and nothing on
screen changes. Tests inject a test key.

## What the core does

- **Versions** are compared by the SemVer precedence rules (`compareKernelVersions`); a version
  is also a folder name, so build metadata is refused.
- **The signed description** (`kernel-latest.json` and `kernel-latest.json.sig`) is checked with
  Ed25519 over the exact bytes served, with a key chosen by id from a list, before a single
  field is read. The reader then refuses any field it does not know.
- **The archive** (`.tar.gz`) is read by a reader written for the narrow format the publisher
  writes. It refuses links and every entry that is not a plain file, any pax key but `path`,
  absolute paths, drive letters, backslashes, colons, empty or dot segments, reserved Windows
  device names, names that end in a dot or a space, names equal after case folding, a file the
  list does not name, a listed file that is missing, a wrong size or hash, more files or bytes
  than the manifest states, and bytes after the end blocks. It writes only inside the folder it is
  given, creates every file new, and removes that folder when it fails.
- **The check** runs one step at a time: fetch, verify, strict parse, channel, sequence, freshness
  (the clock is never trusted below the highest issue time already seen), floor and withdrawn
  versions, the candidate rules, download with the exact size as the cap, unpack, verify every file,
  `kernel.json` agreeing with the manifest, a self-check in a child process, and only then a
  `pending` version.
- **Choosing** happens at every start of a host: a pending version becomes current, the current
  one is checked again (the stored signed pair, `files.json`, the entry, `package.json`,
  `kernel.json` and every `.node` file), and a version that fails is given up for good and the
  previous one, then the bundled one, runs instead.
- **Going back**: a managed engine that fails to start, to answer `initialize`, or lacks a
  required method is given up and the host starts once more; one that ends within ten seconds of
  starting, twice within its first three starts, is given up; "Use this app's own engine" gives
  up every managed version.

## What is on disk

```
<userData>/kernel/
  state.json                      written through a temp file and a rename
  versions/<commandLine>/         an unpacked engine
  versions/<commandLine>.manifest.json  and .sig   the signed pair that authorised it
  tmp/                            downloads and half-unpacked folders; emptied at start
```

`state.json` is the only authority: a folder it does not name is leftover and is removed (never
one a live host was started from; a delete that fails is retried at the next start). A missing or
unreadable state file means nothing is managed and the bundled engine runs.

## What is not claimed

A stolen signing key, or a program that already runs as the same user, is not defended against.
The installer feed stays the weakest link.
