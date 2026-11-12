---
type: Design
title: Desktop engine updates
description: How Namzu Desktop keeps the engine it runs current by itself - a signed description, an archive checked before anything runs, two versions kept, the app's own engine as the fallback - what it checks, what it does not protect, where the files are, how to turn it off, and what a managed computer may block.
resource: packages/desktop/src/main/kernel/
tags: [desktop, engine, updates, trust]
status: draft
generated:
  by: namzu/desktop-engine-updates
  at: 2026-11-12
---

# Desktop engine updates

Namzu Desktop starts its host from a copy of the command line that was put inside the installer.
The command line and its engine are released several times a day; the installer rarely. The app
keeps its engine current by itself, in the background, without asking: it reads a signed
description of the newest engine, fetches one archive for this computer, checks it before anything
runs, starts it the next time a project opens, keeps two versions, and falls back to the engine
inside the installer, which always works.

**A build with no signing key does none of this.** The list of compiled public keys
(`KERNEL_PUBLIC_KEYS` in `src/main/kernel/keys.ts`) is generated from
`packages/desktop/kernel-keys.json` (`node scripts/kernel/write-keys.mjs`, which `pnpm build` runs first and
which writes `src/main/kernel/keys-compiled.ts`), the one file the publisher's verify step and the release
workflow read too; a unit test fails when the two can differ. The list is empty in the repository until the
real key exists. With an empty list the app makes no request, creates no folder, and Settings and About read
exactly as they did before. Tests and the end-to-end run name a test key in the environment, which
only an app that is not packaged accepts.

## What a person gets

- The app looks 30 seconds after launch and then every 4 hours, one check at a time. It asks
  nothing and shows no dialog.
- A newer engine takes effect the next time a project opens (a host starts). A running host is never
  swapped, and the engine in use is whichever one the latest host was started from.
- **Settings > Updates** has the row **Namzu engine**: what runs and where it came from, one
  sentence about the check (up to date and when it last succeeded; a newer engine is ready; could not
  use engine X and went back to the one in use; a newer engine needs a newer version of this app;
  could not check since a date; off; a developer override is in use), the button **Use this app's
  own engine** (shown only while a fetched engine runs or would run at the next project open), and the switch **Keep the engine up to
  date**, next to *Download updates automatically*.
- **Off** (the switch): no check, no download, and the engine the app was installed with is the only
  one that runs. The setting is `keepEngineUpToDate` in the app's `desktop-settings.json`, on by default.
- **About** names the command line and engine that run. Under them one quiet line says where they
  came from: "This app's own engine.", "Updated by itself on 12 Nov." (the order of day and month follows the person's language) or "Developer override." When a
  fetched engine runs, the engine inside the installer is shown as the fallback. **Copy details**
  carries the same facts. Dates are written in the person's own language.
- Text from the feed is never drawn: the screens show version numbers (checked as versions and cut
  to a sane length) and fixed sentences, and a failure is sorted into one of three fixed reasons ("it did not
  start", "it kept stopping", "it did not pass this app's checks").

## What it checks before anything runs

The registry and the release host are not trusted. Every byte that runs is covered by a signature
and a chain of hashes: signed description, archive, file list, files.

1. **The signature.** `kernel-latest.json` is verified with Ed25519 over the exact bytes served, with
   a key picked by id from the compiled list, before a single field is read. A field the reader does
   not know is refused, and so is a manifest that is not in the exact bytes the publisher writes
   (two-space JSON, fields in the order of the text, bundle names sorted, one newline, no repeated key),
   a signature file that is not compact JSON with its fields in order and one newline, a version that is
   not plain `x.y.z`, a sequence below 1, a repeated withdrawn version, a floor above the engine
   offered and a bundle name other than `win32`, `darwin` or `linux` with `x64`, `arm64` or `ia32`.
2. **The channel, the order and the age.** The channel must be the one asked for; the sequence never
   goes down; a description past its expiry (judged against the highest issue time ever seen, not
   the clock alone) installs nothing.
3. **Whether it is a candidate.** A platform entry exists; it is newer than the engine inside the
   installer and than the one in use; not below the lowest allowed version; not withdrawn; the
   `desktopContract` is one this app accepts; and the `dataEpoch` equals the installer's.
   A newer engine that fails the last two is reported as "needs a newer version of this app".
4. **The download** has the exact size as its cap, and its sha512 is computed on the way in.
5. **The archive** is read by a reader written for the narrow format the publisher writes. It refuses
   links and every entry that is not a plain file, a pax key but `path` or `path` twice, absolute
   paths, drive letters, backslashes, colons, empty or dot segments, control characters, characters
   Windows cannot hold in a name (`< > | ? * "`), names over 1024 bytes or a segment over 255, reserved
   Windows device names (the text's list, `CONIN$`, `CONOUT$`, `CLOCK$`, the superscript digits of
   `COM` and `LPT`, and a device name followed by spaces), names that end in a dot or a space, names
   equal after case folding (NFC, upper case, lower case), a name that is a file and a folder, a
   header that is not `ustar`, that has a name prefix or names a link target, a `files.json` that is
   not `JSON.stringify(value)` and one newline, entries in any other order than the order of
   `files.json`, a file the list does not name, a listed file that is missing, a wrong size or hash,
   more files or bytes than the description states, and bytes after the end. `fileCount` and
   `unpackedSize` count the entries of `files.json` (`kernel.json` included, `files.json` not). It
   writes only inside its own folder and creates every file new.
6. **`kernel.json`** inside the archive must say what the description says.
7. **A self-check.** The unpacked engine is run once as the app's own program in node mode, in a
   clean environment (a short list of names; none of the person's variables or keys), with a
   temporary home that is removed afterwards and a time limit. `--version` must equal the
   description's, and the `initialize` exchange of `acp --desktop` must answer as namzu, list every
   method the app requires (the same list the connection to a host checks), and carry facts equal to
   the description's.
8. Only then it is kept as `pending`. Any failure cleans `tmp/` and leaves the engine in use alone.

At every start of a host the engine in use is checked again: the stored signed pair still
verifies, `files.json` matches, and it is still newer than the installer's, not given up, in
contract and in epoch. The first start of a version in a run of the app hashes every listed file
and refuses a file the list does not name; later starts hash the entry file, `package.json`,
`kernel.json` and every `.node` file. The floor and the withdrawn list are read from the stored
signed pair as well as from `state.json`, and the highest sequence and issue time in the stored
pairs count as seen, so deleting or editing `state.json` does not let an older signed answer back
in. An engine that fails a check is given up for good. A read that fails for a moment (a file held
by another program) is tried once more and, when it still fails, only that start goes on without
the engine; it is not given up.

## Never a failed start

A start of a host, a terminal tab or a short command never fails because of the engine folder. Choosing
the engine (`KernelManager.resolve`) is wrapped as a whole: a file operation that fails with any code
(`EPERM`, `EBUSY`, `EACCES`, `ENOENT`, `EIO`, `ENOSPC` and the rest), a `state.json` of any shape (a
folder, binary, `null`, a list, the wrong types, a huge string), a folder that is gone, a check that
throws, an odd setting or odd facts for the engine inside the installer, all end in the engine inside the
installer and one line in the log (`resolve-failed`, with no path in it). Counting a start or an exit,
giving a version up, cleaning up, and writing a log line each swallow their own failures and say so in
the log; setting the feature up at launch (`createEngineDelivery`) returns nothing, so the app runs as it
did before engines could be fetched, when it throws. `never-throws.test.ts` makes every file operation of a
start fail with each of the six codes in turn, with a healthy engine and with a damaged one.

## Going back

- A fetched engine that fails to start, to answer `initialize`, or lacks a required method is marked
  bad, the choice is made again, and the start goes on to the engine before it and then to the
  engine inside the installer, in the same project open. The app ends with a working host whenever
  the engine inside the installer works, and the folders of the engines given up are removed at once. A project folder that
  is gone is not the engine's fault and marks nothing.
- A host on a fetched engine that ends by itself within 10 seconds of starting is counted; two of
  those within an engine's first three starts give it up.
- **Use this app's own engine** gives up every fetched engine; it takes effect at the next project
  open, and a newer engine can still arrive later. A check that is running when it is pressed does
  not make its engine pending afterwards.
- Turning **Keep the engine up to date** off stops a running check, and nothing it fetched becomes
  pending. Quitting the app stops the check too and writes the log before the app exits.
- Two versions are kept (the one in use and the one before, with a pending one waiting). A
  terminal tab or a short command (`computer status`) also runs on the engine chosen at that moment,
  and the folder is not removed while it runs, nor while a host is still starting from it. A delete that the system refuses is retried at the
  next start.

## Where the files are

```
<userData>/kernel/
  state.json                           written through a temp file and a rename
  versions/<commandLine>/              an unpacked engine
  versions/<commandLine>.manifest.json and .sig   the signed pair that authorised it
  tmp/                                 downloads and half-unpacked folders; emptied at start
  updates.log, updates.log.1           JSON lines, 1 MB each, one older file kept
```

`<userData>` is the folder listed as *Desktop app data* in Settings > About. `state.json` is the only
authority: a folder it does not name is leftover and is removed (never one a live host runs from). A
missing or unreadable state file means nothing is fetched and the installer's engine runs. The log
has the time, an event and a few plain facts (versions, a result, a reason); folders, the home
folder, any absolute path (a Windows path is taken out whole, spaces included) and anything about the
person are replaced before a line is written, and a failed write is
dropped.

## What is and is not protected

- **Protected:** a tampered or substituted description or archive, a replay of an older description,
  a description that has expired, an archive that tries to write outside its folder or to link out of
  it, and a fetched engine that does not start or does not speak the app's protocol.
- **Not claimed:** protection against a stolen signing key, or against a program that already runs as
  the same user (it can edit the engine inside the installer too). The installer feed stays the
  weakest link: the installer is not signed.
- **The request** carries only the fixed `User-Agent: namzu-desktop` and the headers the platform's
  network stack always adds (the language is sent as `*`); no identifier, no version of the app, no
  path. Redirects are followed one hop at a time and each address is checked before it is
  requested: an address that is not https (or loopback http), or that carries a user name, is never
  sent a request. No cookies are sent.

## Where the feed is

The default is `https://github.com/cogitave/namzu/releases/download/kernel-latest/`. For development
`NAMZU_KERNEL_FEED_URL` replaces it: any https (or loopback http) address when the app is not
packaged, loopback only when it is packaged; a refused value falls back to the default. A packaged
app never takes a key from the environment. A developer override of the engine (`NAMZU_DESKTOP_CLI`)
wins over everything and turns the check off. `NAMZU_KERNEL_TEST_PUBLIC_KEY` (`<id>:<base64>`),
`NAMZU_KERNEL_TEST_BUNDLED_DIR` (a stand-in for the engine inside the installer) and
`NAMZU_KERNEL_FIRST_CHECK_MS` (0 to 30000) exist for tests and are read only by an app that is not
packaged (the last is a delay, not a key).

## On a managed computer

The fetched engine contains native files (`.node`) under the app data folder. Application control
(AppLocker, Windows Defender Application Control, Smart App Control) may refuse files that are not
signed. The engine then fails to start, is given up, and the app stays on its own engine; nothing
else is lost, and the row says it could not use the engine. Turning **Keep the engine up to date**
off, or asking the administrator to allow the app data folder, stops the repeated attempts.

## The parts

`src/main/kernel/` has no Electron in it; every outside effect is passed in. `version.ts` (SemVer
precedence), `keys.ts`, `manifest.ts` (signature and strict parse), `files-list.ts`, `archive.ts`,
`facts.ts` (`kernel.json` and the `kernel` object of the `initialize` answer, typed with the SDK's own
`AcpKernelFacts`), `fs.ts`, `state.ts`, `store.ts`, `manager.ts` (choosing and
going back), `check.ts`, `self-check.ts`, `feed-fetch.ts`, `log.ts`, `view.ts` (what the screen is
told) and `delivery.ts` (the schedule and the launcher a connection to a host starts through).
`src/main/engine-delivery.ts` assembles them for the app; `src/main/host-launcher.ts` is the narrow
interface the connection to a host sees.

## How the three sides are held together

- **One reader rule set.** The publisher's reader (`scripts/kernel/archive-reader.mjs`,
  `manifest.mjs`, `signing.mjs`) and the app's (`archive.ts`, `files-list.ts`, `manifest.ts`) refuse
  the same things. The deliberately broken archives and signed pairs are data in
  `scripts/__tests__/kernel-cases.mjs`; the publisher's tests and `src/main/kernel/cross-format.test.ts`
  both run every one, with each builder (the publisher's test builder and the app's) and each reader.
  The same file also checks that what the publisher writes (`writeArchive`, `describeArchive`,
  `assembleManifest`, `signManifest`) is read, installed and quick-checked by the app, and that the app's
  test helper gives the same bytes as the publisher's writer for one folder.
- **A real command line.** `real-kernel.test.ts` lays out `resources/cli` as the installer does
  (`dist/`, `package.json`, `kernel.json`), writes `kernel.json` with the publisher's staging function from
  what the built command line (`packages/cli/dist/bin.js`) answers, and checks the app reads it, and that
  asking the bundled engine once (the fallback for an older installer) gives the same facts.
- **The contract inventory.** `desktop-contract.test.ts` holds the app to
  `packages/cli/desktop-contract/inventory.json`, the file the engine's own guard reads: what the app
  announces in `initialize`, the answer fields it reads, the required and optional methods
  (`extension-groups.ts` is the one list of optional groups, read by the connection), every `namzu/...`
  name in the app's source, the notifications it consumes, the flags it passes, the files it reads and the
  environment it hands over. Something the app starts relying on that the inventory lacks fails there.

## Not yet tested

The end-to-end run uses a small stand-in engine that passes the self-check; it never opens a project
on it. A run on a real staged engine (the publisher's real archive and signed pair, a project opened
on it, going back from a real failure) is a later integration change.
