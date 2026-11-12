---
type: Guide
title: Desktop engine bundles - publishing
description: For maintainers. How the engine that Namzu Desktop keeps current by itself is staged, packed, described, signed and published - the file formats, every publisher command, the release workflow, where the signing key lives, and what to do when a key is added, retired, lost or leaked.
resource: packages/desktop/scripts/kernel
tags: [cli, desktop, release, signing, maintainers]
status: stable
generated: { by: process:agent, at: 2026-11-12T00:00:00Z }
---

# Desktop engine bundles: publishing

This page is for the people who publish. The app side (how Desktop fetches, checks and switches engines)
is a separate piece of work and is described on the [Desktop application](desktop.md) page once it lands;
everything here is what the app reads.

Words used here: the **kernel** is the Namzu command line plus the engine (the SDK) it carries, as one folder
that starts with `dist/bin.js`. The **bundled kernel** is the copy inside the installer
(`resources/cli`). A **bundle** is a kernel folder packed as an archive for one platform. The app's screens
say "engine" and never "kernel" or "bundle".

## What is published

Everything goes to one rolling prerelease, `kernel-latest` (created with `--latest=false`, like the
`desktop-latest` installer feed, so the npm releases keep the "Latest" badge). The app reads it from
`https://github.com/cogitave/namzu/releases/download/kernel-latest/`.

| File | What it is |
|---|---|
| `namzu-kernel-<commandLine>-<platform>-<arch>.tar.gz` | the archive of one kernel for one platform |
| `kernel-latest.json` | the signed description of the newest kernel (the manifest) |
| `kernel-latest.json.sig` | the signature over the exact bytes of the manifest |

The release holds the newest archive and the one before it. Nothing else.

## The formats

These are fixed: the app reads them from this text. A change of shape changes the `schema` number.

### `kernel.json`

At the root of every kernel folder, bundled and fetched. Written by the staging step from what the staged
kernel itself answers (never typed): `--version`, and the `initialize` exchange of `acp --desktop`, which
carries `kernel: { engine, dataEpoch, commandLine, desktopContract }` (see [Kernel facts](../sdk/kernel-facts.md)).

```json
{"schema":1,"commandLine":"51.1.0","engine":"62.13.0","desktopContract":1,"dataEpoch":1,"platform":"win32","arch":"x64"}
```

A kernel that does not state its facts (no `kernel` object, a missing `desktopContract`, a version that
disagrees with its `package.json`) stops the staging with one plain message. `platform` and `arch` are those of
the target the kernel was staged for, not of the machine that staged it.

### `files.json`

Every regular file of the kernel folder except `files.json` itself (`kernel.json` is included), `path` with
`/` and relative, sorted by code unit order, serialised as `JSON.stringify(value)` and one newline:

```json
{"schema":1,"files":[{"path":"dist/bin.js","size":1234,"sha256":"<hex>"}]}
```

### The archive

gzip over a tar stream, written so that the same folder gives the same bytes:

- entries are regular files only (type `0`), in the order of `files.json`, with `files.json` first;
- a name longer than 100 bytes uses a pax header (`x`) that carries `path` and nothing else;
- mode 0644, uid and gid 0, mtime 0, no user or group name; no folders, links, devices or sparse entries;
- the stream ends with two zero blocks and nothing after them;
- gzip is level 9 with the default window and memory settings; the header has no flags (so no file name), a
  zero time, and a fixed operating-system byte (3).

The reader refuses the **whole** archive on: any other entry type; a pax key other than `path`; an absolute
path, a drive letter, a backslash, a `:`, an empty or `.` or `..` segment, a Windows device name (`CON`,
`PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without an extension), a segment ending in a dot or a space;
two names equal after case folding; a file `files.json` does not list, or a listed file that is missing; a
size or sha256 that differs; more files or more unpacked bytes than the manifest states; bytes after the end
blocks. Beyond the text, both readers (the publisher's and the app's, which share one list of broken cases in
`scripts/__tests__/kernel-cases.mjs`) also refuse: a header that is not `ustar`, that has a name prefix or names a
link target; octal fields that are not plain octal; a `files.json` that is not serialised exactly as above, whose
fields are not in the order of the text or that holds a repeated key; entries in an order other than the order of
`files.json`; a pax header that carries `path` twice or is larger than 8192 bytes; control characters (below
space and DEL) in a name; the characters `< > | ? * "`, which Windows cannot hold; a name over 1024 bytes or a
segment over 255; a name that is a file and a folder (`a` and `a/b`); a name equal after case folding to
`files.json`; and the Windows device names the text does not list (`CONIN$`, `CONOUT$`, `CLOCK$`, the
superscript forms `COM¹`, `LPT²` and so on, and a name such as `con .txt`).

"Case folding" is Unicode composition (NFC), then upper case, then lower case. That joins the pairs that
lower-casing alone misses: the two Greek sigma forms, `ß` and `SS`, the Kelvin sign and `K`, and `é` written
as one character or as `e` plus an accent. A reader on another platform must fold at least this much, or two
files that are different in the archive can be one file on a case-insensitive disk.

Counting: `fileCount` and `unpackedSize` count the kernel's own files, the ones `files.json` lists
(`kernel.json` among them); `files.json` itself is not counted. The reader refuses an archive with more.

### The manifest

`kernel-<channel>.json`; only `latest` exists. Written with two-space indentation and one newline, keys in this
order:

```json
{
  "schema": 1,
  "channel": "latest",
  "sequence": 1794480000,
  "issuedAt": "2026-11-12T10:00:00Z",
  "expiresAt": "2026-11-26T10:00:00Z",
  "minimumKernel": "51.1.0",
  "withdrawn": [],
  "kernel": {
    "commandLine": "51.3.0", "engine": "62.14.0", "desktopContract": 1, "dataEpoch": 1,
    "bundles": {
      "win32-x64": {
        "file": "namzu-kernel-51.3.0-win32-x64.tar.gz",
        "size": 41234567, "sha512": "<hex>", "filesSha512": "<hex of the files.json bytes>",
        "fileCount": 5123, "unpackedSize": 123456789
      }
    }
  }
}
```

`sequence` is the issue time in seconds and never goes down. `file` is a bare name fetched from the same
folder. `withdrawn` lists command line versions the app must no longer use; `minimumKernel` is the floor: no
fetched kernel below it may run. Unknown fields, at any level, are refused. Both readers also refuse: a
version that is not plain `x.y.z` (no prerelease, no build part, no leading zero, at most nine digits a part);
a sequence below 1; a withdrawn version listed twice; a floor above the kernel offered; a bundle name that is
not `win32`, `darwin` or `linux` with `x64`, `arm64` or `ia32`; a bundle `file` over 128 characters; a bundle
larger than 2 GiB, more than 8 GiB unpacked or more than 200000 files; a `fileCount` of 0; a `desktopContract`
or `dataEpoch` above 1000000; a manifest over 1 MiB; and, as the next section says, anything but the exact bytes.

### The signature

`kernel-latest.json.sig`: `{"schema":1,"keyId":"k1","algorithm":"ed25519","signature":"<base64>"}`. It is
Ed25519 over the exact bytes of the manifest file. The app keeps both files byte for byte. The file is compact
JSON with its keys in this order and one newline; a reader refuses any other layout, and a key id is 1 to 32
letters, digits, `.`, `_` or `-`, starting with a letter or digit.

## The commands

All are plain `.mjs` under `packages/desktop/scripts/kernel/` and use nothing but node's own modules, so the
signing and verifying steps run with nothing installed. Run them from the repository root with
`node packages/desktop/scripts/kernel/<name>.mjs`. Staging needs `pnpm -r build` first and writes outside
the repository.

| Command | Does |
|---|---|
| `stage.mjs <out-dir> [--target win32-x64]` | Stages a kernel folder with the **same function** the installer staging uses for `resources/cli` (`stage-cli.mjs`: deploy for the target, lean, target natives, drop dead weight, start it and check it), then writes `kernel.json`. The installer staging writes the same `kernel.json` into the bundled copy; its result is otherwise unchanged. |
| `pack.mjs <kernel-dir> --out <dir>` | Writes `files.json`, the archive and `<archive>.bundle.json` into `<dir>` (never into the kernel folder), reads the archive back with the independent reader, and prints the bundle entry. |
| `describe.mjs <archive> [--out file] [--expect-version v]` | Prints the bundle entry built from the archive alone. The publish job uses it so it trusts nothing the build job wrote beside the archive. |
| `assemble-manifest.mjs --out <file> --bundle <entry>... [--previous <manifest>] [--channel latest] [--issued-at <ISO>] [--lifetime-days 14] [--floor v] [--withdraw v]... [--unwithdraw v]...` | Assembles the manifest from one or more bundle entries. |
| `assemble-manifest.mjs --out <file> --reissue <manifest> [same options]` | Re-issues the previous manifest with new times and a higher sequence. |
| `sign.mjs <manifest> [--out file] [--keys file] [--key-id id]` | Signs with the key in `NAMZU_KERNEL_SIGNING_KEY`. |
| `verify.mjs --manifest <file> --sig <file> [--keys file] [--archive <file>] [--now <ISO>] [--allow-expired]` | The publisher's last check. |
| `key.mjs [--id k1] [--private]` | Makes a key pair. |
| `unpack.mjs <archive> <out-dir> [--manifest file]` | Unpacks with the reader's rules (for inspection; the folder is removed if the archive is refused). |
| `release-local.mjs --out <dir> [--target t]... [--keys file] [--previous file] [--floor v] ...` | The whole release into a folder, without publishing: stage, pack, manifest, sign when a key is in the environment, verify. |
| `release-assets.mjs <tag>` | The asset names on the rolling release, one per line. A release that does not exist yet lists nothing; any other failure (a rate limit, a server error) exits non-zero instead of reading as "no assets", which would let the workflow take a published archive for a leftover and replace it, and start the manifest chain over. |
| `release-plan.mjs decide ...` / `prune ...` / `upload-plan ...` | The decisions of the workflow (what a run does; which archives to remove; whether the archive about to be uploaded is new, replaces a leftover or is refused), as code that is tested. |
| `write-keys.mjs [--check]` | Writes the app's compiled key list from `kernel-keys.json`, or checks it is current. |

**Manifest rules** (`assemble-manifest.mjs`): a sequence lower than or equal to the previous manifest's is refused (the
sequence is the issue time in seconds, so pass a later `--issued-at`); a kernel older than the previous
manifest's is refused, and the same version is a re-issue, not a new manifest; the floor is never lowered and
may not be above the kernel offered (with no `--floor` the previous floor is kept; a first manifest uses the
kernel's own version); the withdrawn list is kept unless `--withdraw` or `--unwithdraw` change it, and the
kernel being offered may not be on it. A re-issue keeps the kernel and bundles and may raise the floor or
change the withdrawn list by the same rules.

**Verify** checks, in order: the key list is not empty; the signature file's shape; the key id is in the list;
the signature matches the exact manifest bytes; the manifest parses strictly and is in the exact form of the
text (so a repeated key or a different layout cannot be read two ways); it has not expired (unless
`--allow-expired`) and is not issued in the future; and, with `--archive`, the archive's size and sha512 match the
bundle, the reader accepts it within the manifest's limits, and its `files.json` hash, file count, unpacked size
and `kernel.json` agree with the manifest. The reader (`archive-reader.mjs`) shares no code with the writer
(`archive-writer.mjs`), so a pass also proves the writer follows this page.

**Key** with no flag prints the public entry and throws the private half away. With `--private` it writes
**only** the PKCS#8 PEM to standard output, so it goes straight into a secret store, and prints the public entry
to standard error. It never writes a file and refuses a terminal on standard output unless `--allow-tty` says it
is meant:

```sh
node packages/desktop/scripts/kernel/key.mjs --id k1 --private \
  | gh secret set NAMZU_KERNEL_SIGNING_KEY --env kernel-release
```

The signing key is read from the environment variable `NAMZU_KERNEL_SIGNING_KEY` (PKCS#8 PEM, or base64 of it)
and from nowhere else: never a file, never an argument. It is not written, not printed and not put in an error
message; a test runs every command with a known key in the environment, on success and on failure, and searches
all output and every file written for it.

Determinism. Packing the **same staged folder** twice gives the same bytes (the compressed bytes depend on the
zlib that node carries, so the publisher fixes node 24). Staging the same commit twice gives the same folder
except for one thing the staging does not control. The kernel staging removes `node_modules/.modules.yaml`
(pnpm writes the absolute staging path and a time into it; nothing reads it at run time; only the kernel staging
drops it, the installer's folder keeps it). `THIRD-PARTY-LICENSES.txt` is the remaining difference: it names the
version of each package whose code was compiled into the bundle, as `pnpm deploy` resolved it at that moment,
and two stagings of one commit were seen to name `slice-ansi` 9.0.1 in one and 10.0.1 in the other (the lock
file says 9.0.0). The files of the packages that are kept were identical in both. So the archive is a record
of what was staged, not a promise that staging again gives the same bytes; the manifest's hashes are those of
the archive that was uploaded.

The release key is never given to staging. `pnpm deploy` runs third-party install code and the staged program
is started to check it; both get an environment without `NAMZU_KERNEL_SIGNING_KEY`, so even a local
`release-local.mjs` run with the key set only shows it to the signing step.

## The public key list

`packages/desktop/kernel-keys.json` is a JSON array of `{ "id": "k1", "publicKey": "<base64 of the 32 raw bytes>" }`.
It is **empty** until the real key exists. The publisher scripts read it, and the app is built from the same
file: `node scripts/kernel/write-keys.mjs` (run first by `pnpm build`) writes `src/main/kernel/keys-compiled.ts`
from it, `KERNEL_PUBLIC_KEYS` reads that, and a unit test fails when the two differ. An app built with an empty
list never asks for an engine; a packaged app takes no key from the environment. After editing the file, run
the command and commit both.

## The release workflow

`.github/workflows/kernel-release.yml` (name "Kernel release") runs:

- when the workflow that publishes the packages (`Release`) finishes successfully on `main` for a push;
- by hand, with inputs `floor` (raise the floor), `withdraw` and `unwithdraw` (a version each);
- every Monday at 05:17 UTC, to re-issue the current manifest so it never expires while nothing changed (a
  manifest lives 14 days).

It builds only when the command line version at the commit is **newer** than the one in the current manifest
**and** is on the npm registry; otherwise the run ends quietly with a notice that says why. With no key in the
list it also ends quietly. Three jobs:

- `plan` (read-only token, no secret) decides: build, re-issue, or nothing.
- `build` (Linux, read-only token, no secret) installs, builds, stages for `win32-x64`, packs, reads the
  archive back, and hands it over as a one-day run artifact. Install scripts of third-party packages run here
  and only here.
- `publish` is the only job with the signing key (from the protected environment `kernel-release`) and the only
  job with `contents: write`. It checks out `main` (not the triggering commit), installs **nothing**, rebuilds
  the bundle entry from the archive itself, assembles the manifest from the previous one (after verifying the
  previous one against the key list), signs, verifies the result against the key list in the repository (an
  empty list, or a signature no listed key makes, stops it), then uploads the archive first and the signed pair
  last, and removes archives older than the previous one. An archive that a published manifest names is never
  replaced (bump the version instead); one that none names, which is what an upload cut after the archive and
  before the signed pair leaves, is replaced. That decision is `release-plan.mjs upload-plan`, tested code
  that is given the manifest that verified at the start of the run, not shell.

No value from the triggering run or from an input is interpolated into a shell line; each goes through `env`.

Setting it up, once, by the owner:

1. Create the environment `kernel-release` with a **deployment branch rule that allows only `main`**.
2. Make a key (above) into the secret `NAMZU_KERNEL_SIGNING_KEY` of **that environment**, never a repository
   secret. The `github.ref == main` conditions in the workflow file are not a boundary: a branch can edit its
   own copy of the file and start it by hand. Only the environment's branch rule and the fact that the secret
   exists nowhere else keep the key from such a branch.
3. Do **not** add required reviewers to the environment unless someone approves every Monday. A scheduled run
   waits for an approval it never gets, and an unapproved fortnight lets the 14-day manifest expire, which is
   exactly what the schedule exists to prevent. The protection that matters here is that `main` needs a review
   before any code, including this workflow and the scripts it runs, can change.
4. Paste the public entry into `kernel-keys.json` and merge. Until then the workflow ends quietly.

**A run right after the package publish** asks the registry up to six times, thirty seconds apart, whether the
new command line version is there yet. If it still is not, the run ends quietly and the Monday run builds it;
publish by hand (`workflow_dispatch`) to avoid the wait.

### When an upload was cut in half

The signed pair is two uploads, so a run that dies between them leaves a new manifest beside the old signature
(or none). Apps refuse that pair and keep the engine they have; nothing breaks for people. So that it does not
stop every later run, `publish` saves the pair that verified at the start of a run as `kernel-previous.json`
and `kernel-previous.json.sig` on the same release, before replacing it. A later run whose current pair is
incomplete or does not verify says so in a warning and starts from the saved pair; if there is no saved pair it
stops with a plain message. A manifest that is present with no `.sig` counts as a pair that does not verify.
When it starts from the saved pair, the archive of a version that was already uploaded by the cut run is still
on the release. If no verified manifest names it, the next run replaces it and the version can still be
published; if the manifest it starts from does name it, it is not replaced: bump the command line version, or
re-issue the saved manifest and let the next version go out normally.

### Checks this workflow is not part of

It is a packaging job, like [the installer release](desktop.md#installing-and-updating), and runs none of the
gates of `ci.yml` or `release.yml`. It is not in their gate parity
(`.github/scripts/check-workflow-gate-parity.mjs` reads those two files only) and not in the list of jobs the
validated-tree record waits for, because it runs after a release, not before a merge. Why that is acceptable:
the scripts' own tests (`packages/desktop/scripts/__tests__/kernel-*.test.mjs`) run in the ordinary
`pnpm -r test` of every pull request, and `publish` re-verifies everything it signs. What no check here covers:
the workflow file itself is not linted or run before it first runs for real, and the build job's output is not
proven to be what the registry package contains (the plan job checks that the version exists on the registry,
not that the staged files are byte for byte the published package). The signature says that the publish job
signed what the build job made at a commit on `main`; it does not say the build was clean.

## Keys over time

**Add a second key.** Make a pair (`key.mjs --id k2 --private`), put the new secret in place beside the old one
only if the workflow is changed to name it (it reads one secret), and add the public entry to
`kernel-keys.json` *without removing the first*. Ship an app release built with both. The app accepts a
manifest signed by either listed key, so publishing can switch to the second as soon as the first app with both
is out.

**Retire the first.** After the app release carrying both keys is what people run (the installer feed and the
installed-base lag decide when), switch the secret to the second key, publish, and remove the first from
`kernel-keys.json` in the next app release. An app that still lists only the first key stops accepting
manifests signed by the second and keeps running the engine it has.

**A key is lost.** Nothing already installed breaks: apps keep the engine they run, and the bundled engine
always works. No new engine can be signed. Make a new pair, add its public entry, and ship an app release: the
app release is the only way a new key reaches people, because the keys are compiled into the app and an app
never takes a key from the network or the environment (an unpackaged development app may take one test key from
`NAMZU_KERNEL_TEST_PUBLIC_KEY`).

**A key is leaked.** Treat it as lost, and act faster: remove the secret, ship an app release without the leaked
public key and with a new one. Until people run that release, whoever holds the key can sign an engine their
app accepts. Raising the floor (`workflow_dispatch` with `floor`) and withdrawing versions limits what a
manifest signed with the old key could roll back to, but cannot stop a new, malicious one signed with it. This
is the limit of the design: the installer feed is unsigned too, so it is the weakest link.

## Local trial

```sh
pnpm -r build
KEY="$(node packages/desktop/scripts/kernel/key.mjs --id t1 --private 2>pub.txt)"   # throwaway
# put the public entry from pub.txt in a list file of its own, never in kernel-keys.json
NAMZU_KERNEL_SIGNING_KEY="$KEY" node packages/desktop/scripts/kernel/release-local.mjs \
  --out /tmp/kernel-trial --target win32-x64 --keys /tmp/trial-keys.json --floor 51.1.0
```

`/tmp/kernel-trial/release/` then holds what would be uploaded. Without the key in the environment the command
stops after the manifest and says the result is unsigned.
