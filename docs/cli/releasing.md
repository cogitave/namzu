---
type: Guide
title: Releasing by hand
description: How to publish the npm packages and the Desktop installer from a maintainer's machine when the hosted CI cannot run, with the same checks the workflows make.
resource: scripts/release.mjs
tags: [release, npm, desktop, changesets]
status: stable
generated: { by: process:agent, at: 2026-11-22T00:00:00Z }
---

# Releasing by hand

Releases normally run in `.github/workflows/release.yml` (npm, through changesets) and
`.github/workflows/desktop-release.yml` (the Desktop installer). When Actions cannot run, the same
releases can be made from a maintainer's machine with `pnpm release`. It is the only allowed manual
path (`AGENTS.md`), and only with the owner's go for that specific release. It never runs
`npm unpublish`, never publishes a version the registry already has (it skips it and says so),
and signs in only through npm's browser approval (`pnpm release login`, or `pnpm release local` when the session has expired). It uses only your own npm session: no access token and no one-time code.

Every command takes `--dry-run`, which runs every check and stops before anything is published,
tagged, uploaded or deleted. Start with one.

## npm packages

1. **Version.** Changes land with a `.changeset/<slug>.md`. Run `pnpm release version`: it runs
   `pnpm changeset version`, prints each bump and stops. Put the result on a branch as
   `chore(release): version packages`, open a PR and merge it. Never edit a version by hand.
2. **Gates.** `pnpm release local` refuses without proof that the full gates (the `ci_gates` table in
   `AGENTS.md`) passed on exactly this tree. The proof is a text file with a line `tree <tree sha>` and a
   line `DONE fail=0`, and no `fail=` other than 0. A gate runner records it with
   `pnpm release record-gates --summary <summary file>`, which writes `.release/gates/<tree sha>.txt`
   (the folder is git-ignored, per working copy). A summary kept elsewhere is passed with
   `pnpm release local --gates <summary path>`; it must name this tree too.
3. **Release.** From main, signed in to npm. Sign-in and every publish approval happen in the browser
   (npm's web authentication, with a passkey or security key); one-time codes are not used. Sign in once
   with `pnpm release login` (it runs `npm login --auth-type=web`, opens the approval page, waits for you
   to approve, then checks `npm whoami`), then:

   ```
   pnpm release local --dry-run
   pnpm release local
   ```

   npm's browser sign-in lasts hours, not days. `pnpm release local` checks `npm whoami` before the checks
   and again before publishing; when it fails, a real run opens the same sign-in approval and goes on once
   you approve, and a dry run says to run `pnpm release login` and stops. Nothing is typed to npm
   and the command sets no timeout of its own, so it works from a shell without a keyboard, such as a
   chat tool's `!` shell.

### Approvals open in the browser

npm cannot always open a browser itself (from WSL it says "Set the BROWSER environment variable"), and a
chat tool's shell may mask the one-time part of the address (`.../login/cli/***`), so a printed address is
useless. The command therefore catches every npm line that asks you to authenticate or approve (login,
publish approval: "Authenticate your account at", "Login at", "Open this URL", `npmjs.com/auth/` and
`/login/` addresses), opens the address itself and prints only
`Approval page opened in your browser (<host>)`. The address is never printed. npm keeps polling and
finishes when you approve in the browser. It runs npm under a pseudo-terminal (`script`) because npm only
polls for the approval when it has a terminal; it never presses Enter for npm and keeps its input open.

The browser is opened with the first of these that exists: the `BROWSER` environment variable; on WSL
`~/.local/bin/open-in-windows`; `open` on macOS; `xdg-open` on Linux; PowerShell `Start-Process` on Windows
(the address travels in an environment variable, never in command text). If none exists the command says
plainly that it cannot open a browser and that you should run it in a terminal that can show the full address.

**WSL helper.** Create `~/.local/bin/open-in-windows` (`chmod +x`). The address is passed to Windows in an
environment variable forwarded through `WSLENV`, so it is never parsed as command text:

```sh
#!/bin/sh
NAMZU_OPEN_URL="$1"
export NAMZU_OPEN_URL
WSLENV="${WSLENV:+$WSLENV:}NAMZU_OPEN_URL"; export WSLENV
exec powershell.exe -NoProfile -Command 'Start-Process $env:NAMZU_OPEN_URL'
```

In order, it refuses unless: the working tree is clean and HEAD equals `origin/main` (it fetches
first); no changeset is pending (it tells you to run `pnpm release version`); the gate proof holds.
It then builds, runs the pre-publish consumer install check
(`.github/scripts/verify-consumer-install.sh`) and the publish-metadata gate, requires a clean tree
afterwards, and checks `npm whoami` again. It asks the registry about each package with `npm view <pkg>@<version>`
and lists what it will publish (a registry error other than a 404 stops it). Then it runs
publishes the packages one at a time in dependency order, each with
`pnpm publish --provenance=false` run in the package's own folder (a `--filter` publish rewrites npm's
arguments and drops the flag), and goes on only after the previous one succeeded.
The packages ask for a provenance attestation in `publishConfig`, which only the release workflow's CI
identity can produce; npm refuses that request on a maintainer's machine, and the flag (which outranks
`publishConfig`) publishes a by-hand version without one. A version published by the workflow keeps it. npm's output is streamed live. npm asks for an
approval at a URL and waits; the command opens it in the browser as described above and sets no timeout
of its own (npm has its own; its message is shown if it expires). Before the first publish it says that the approval page may offer to not
ask again for a few minutes from this address, which saves one approval per package. On the first failure it
stops and lists which packages were already published and which were not; run the same command again to
resume, because it skips every version already on the registry. It then verifies every published version
with `npm view`, retrying for about ten minutes (a large package can take several minutes after npm accepts it
before it shows), tags and pushes to `origin` the tags it does not have yet, only after every version is
visible, and writes `.release/notes/release-<date>-<commit>.md`. If a version never shows in that time, no tag
is pushed and the message says what to check; nothing is unpublished. Once it shows, run the same command
again: with every version on the registry it publishes nothing and pushes only the tags `origin` lacks (an
existing tag is never moved). A dry run pushes no tag.

Provenance (`NPM_CONFIG_PROVENANCE`) is a CI feature and is not set here. GitHub Releases are not
created by this command; `node .github/scripts/backfill-github-releases.mjs` fills them when `gh` can write.

## Desktop installer

`@namzu/desktop` versions come from changesets as above. With the version PR merged:

1. `pnpm release desktop --pal-computer-image <archive> --pal-computer-manifest <manifest>` checks that
   HEAD is clean `origin/main`, that `packages/desktop/package.json` and its `CHANGELOG.md` agree, builds,
   runs `stage-installer.mjs`, checks the staged Pal computer image and packs `.release/desktop-stage-<version>.tgz`.
   The image and manifest come from the previous installer or from `packages/sandbox/local-computer/build-image.mjs`
   (see [Namzu Desktop](desktop.md)). `--version <v>` asserts the expected version; `--out <dir>` moves the stage folder.
2. It then stops and prints the Windows step: unpack the tarball on Windows, install the pinned
   `electron-builder` and run it with `--win nsis --x64 --publish never` and
   `CSC_IDENTITY_AUTO_DISCOVERY=false`, as the workflow's `package` job does. Copy exactly
   `Namzu-Setup-<v>.exe`, its `.blockmap` and `latest.yml` into one folder.
3. `pnpm release desktop publish --installer <folder> [--dry-run]` does the `publish` job: the folder holds
   exactly those three files; `latest.yml` names this version, the installer and its sha512; `gh` is signed in;
   the version is not on the `desktop-latest` feed; it finds the previous installer there, builds the notes
   with `feed-release-notes.mjs` (to `.release/desktop-notes-<v>.md`), creates the rolling release if missing,
   uploads the installer and blockmap, then `latest.yml` last, sets the title and notes, and removes
   installers older than the previous one. The Desktop release itself still needs the owner's go.
