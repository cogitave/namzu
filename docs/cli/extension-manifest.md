---
type: Reference
title: Extension manifest
description: The namzu-extension.json a package carries: permissions with a purpose each, the data it produces and its retention, languages, the process entry, the three licence kinds, declared network hosts, pages and chips the extension draws, starting at sign-in, and signing, with the rules that refuse a manifest.
resource: packages/cli/src/integrations/extensions/manifest.ts
tags: [cli, extensions, manifest, locales, permissions]
status: stable
generated: { by: process:agent, at: 2026-11-18T00:00:00Z }
---

# Extension manifest

`namzu-extension.json` is the whole truth about what an extension asks for and why. It is
parsed strictly: an unknown key is an error (only keys starting with `x-` are free), a
reserved key is refused by name, and every failure names the **rule**, the **path** and the
fix. `namzu extension validate <folder|file>` runs the same checks without installing
anything. See [Extensions](extensions.md) for what happens with it.

## Names

One convention names an extension everywhere, so a person (and a script) can tell what a file or a process is. The example is the activity extension.

| What | Rule | Example |
| --- | --- | --- |
| Project and repository | `namzu-extension-<name>` | `namzu-extension-activity` |
| Customer-specific build | `namzu-extension-<customer>-<name>` | `namzu-extension-acme-activity` |
| Manifest `id` | the reverse DNS name of the publisher's domain, then the extension name: lowercase letters, digits and hyphens in each part, at least three parts separated by dots | `com.cogitave.activity` |
| Package file | `<id>-<version>-<platform>.nzx` | `com.cogitave.activity-0.2.0-win32-x64.nzx` |
| Process (executable) | `namzu-<name>` (`.exe` on Windows) | `namzu-activity.exe` |
| Display name | `Namzu <Name>` in English, the product's own words in other languages | `Namzu Activity`, `Namzu Etkinlik` |

Why:

- The **id** is the key to everything Namzu keeps for the extension (its data folder, your acknowledgement, its licence). A domain you control is the one name nobody else can claim, so two publishers cannot collide, and the parts sort the same way a domain does. It is **stable forever**: a rename is a different extension, with its own data and its own acknowledgement. A different spelling of the same publisher is never an update.
- The id is refused when it does not have that form, with a sentence that shows a correct one (`com.example.activity`). Hyphens are allowed inside a part (`io.example-corp.notes`), not at its ends, and the dot is the only separator between parts.
- The **package file** name carries the three things a person asks before opening it: which extension, which version, for which platform. `namzu extension validate <file>` prints a warning, never a refusal, when a package file is not named that way (a package for several platforms may carry any one of them), because the file name is not part of what is signed.
- The **process** name starts with `namzu-` so it is recognisable in a task list and in an endpoint-protection rule, and carries the short name, not the id, so it stays readable.
- The **project** name starts with `namzu-extension-` so a search for extensions finds them and a customer's build is told apart from the product's.

## Permissions, purposes, data, retention

A permission is `{ id, level, optional, personalData, summary, purposes[], prompt? }`. `personalData` says whether the permission lets the extension see data about the person; Namzu keeps a table for its own ids (the five `os.*` ids are `true`, `background.signin` is `false`) and refuses a different value (rule `B3`); a permission of your own (`x-...`) declares it.

- `id` is one of the five ids of this version, `background.signin` (starting at sign-in, below), or `x-<your own>`, shown to the person as
  "Other" with its purpose: `os.foregroundWindow` (which program is in front, not its
  title), `os.lastInputTime` (seconds since the last input), `os.sessionEvents` (lock,
  unlock, sleep, wake), `os.inputCounts` (counts of key presses, clicks, wheel ticks and
  moves, never which key or where), `os.screenChange` (a tiny grey grid compared in memory
  and discarded; only a number is kept).
- `purposes` has **at least one** entry, each `{ id, text }` in plain words. A permission
  with no purpose is refused when the package is added, and so is a permission that no data
  kind uses.
- `optional: true` means it is off until you grant it later and needs a `prompt`.
- `level` (`low`, `medium`, `high`) is a hint for the dialog, not a security control.

Reserved in this version and refused by name: `os.windowTitle`, `os.browserDomain`,
`os.pointerDevices`, `host.decide`, `host.distill`, `host.memory`, `tools.agent`,
`network.hosts`, `model.call`. Never offered: `os.keyContent`, `os.screenshot`,
`os.clipboard`, `os.microphone`, `os.camera`, `os.location`. The keys `modelAccess`,
`policy`, `managed`, `analysis`, `contributes.toolServers`, `skills`, `hooks`, `panels`,
`plugin` and `updates.source` are refused, as are `monitoringKind: content` and a resource
`enforcement` other than `report`. `entry.process.runAtLogin` was removed: starting at
sign-in is the `background` block below.

Each data kind in `produces[]` is `{ id, from[], description, grain, fields[],
retentionDays (1 to 365), leavesMachine: false }`. A field named like content (`key`,
`title`, `url`, `path`, `x`, `y`, `image`, `pixels`, `clipboard` and the like) is refused,
which is how "never which key" and "no window title" are held at the declaration.

## Languages

The manifest names a `defaultLocale` (a language tag such as `tr`, `en`, `pt-BR`) and
**carries every text in it**; `locales` lists every language the package has any text in
and must contain the default. Other languages are optional translations, and a text may
carry any subset. Namzu shows your own language when the package has it (the exact tag,
then its language) and the default otherwise, with a line saying so. **The platform
requires no particular language.** Rules: `L1` the default is listed, `L2` every text has
the default and uses only listed tags, `L3` the notice exists in the default and in no
unlisted language, `L4` a notice file starts with `<!-- locale: <tag> -->` for the language
it is in.

## Entry, contributions, legal, licensing, signing

- `entry.process`: `command` per platform `{ exe, args[] }` (a path inside the package and an
  argument list; never a shell string), `env` with only `${extensionDir} ${dataDir} ${id}
  ${version} ${locale}` (a literal secret is refused), `restart` (`policy`, `backoffMs`,
  `maxPerHour`, `stableAfterMs`), `stopGraceMs`. `entry.maintenance` is a one-shot command
  that may only delete, run when the process is not running.
- `contributes.endpoint`: `namzu-ext-query/1` (or `/2`, which adds `actions`) and the queries, each with the data kinds it may
  return, a JSON Schema file for its answer and a size limit. `pages` is the "What is
  collected" page, drawn by the host. `indicator` gives the sentences for `collecting` and
  `degraded`; `alwaysVisibleWhenRunning` must be `true`. `settings` holds the model API key
  row (`usedBy: none`).
- `legal`: `noticeVersion`, a notice file per language with its hash, the acknowledgement
  mode and how long the record is kept, the jurisdictions.
- `licensing`: one of three kinds (see Licence kinds). `signing`: the publisher key id, `signatures/manifest.sig` and
  `files.sha256.json`.
- `files` is only `${dataDir}`; `updates` is `askAgain` and `never` fetch.
- `network` is `{ mode: "none" }` or `{ mode: "declared", hosts[] }` (see Network hosts).

Rules a schema cannot say: `P1` no duplicate ids, `P2` data comes from declared permissions,
`P3` every permission is used, `P4` no content-like field, `Q1` a query returns produced
kinds, `Q2` the page's counts query exists, `E1` a command for exactly the declared
platforms, `E2` no literal secret in `env`, `S1` a secret is used by nothing, `K1` every
file the manifest names is in the package and the notice hashes match, `K2` an executable
has its execute bit, `V` at most 256 KiB, 12 levels, valid UTF-8 without control characters.

## Licence kinds

`licensing.kind` is one of three. **None**: `{ "kind": "none" }`, no licence screen and no
licence state; the install dialog says "No licence needed." **Key**: the offline, signed
licence file, checked against a key file the package carries (`verifier`, `claims`,
`graceDays`). **Service**: the publisher's own licence service, `{ required, claims,
onInvalid, service }` with `service` = `{ protocol: "namzu-license/1", baseUrl (https, no
port), verifier (the key that signs its answers), refreshHours (1 to 168),
offlineGraceDays (0 to 60), sends[], releaseOnRemove }`. `sends` lists every field a check
carries (`licenseKey` and `machineHash` are required, `extensionId`, `extensionVersion` and
`hostVersion` optional); the install dialog prints it. The protocol is in
[Extensions](extensions.md#licence-none-key-or-service).

## Network hosts

`network` is `none`, or `declared` with `hosts[]`, each `{ host, purpose, for[] }`. `host` is a
DNS name (no IP address, no wildcard, no scheme; https on 443 only) and `for` says what the
host is for: `license` (Namzu's own licence check, enforced), `ui` (a page's content policy,
enforced) or `process` (declared, shown and audited, **not** enforced in this version).
`privacy.leavesTheMachine` is `nothing`, `licence-check-only` or `declared` and must match the
hosts (rule `N2`).

## Pages, icon and chips (`ui`)

`ui` is the extension's own look inside Namzu: `{ icon (an .svg or .png, at most 32 KiB),
accent (#rrggbb), pages[] (at most 6), chips[] (at most 2) }`. The accent colours a dot or
a border on the extension's own entries and chips; text colour stays Namzu's.

- A **page** is `{ id, title, slot, entry, icon?, minHeight?, usesNetwork?, bridge }`. `slot` is
  `sidebar` (a rail entry), `settings` (a page opened from the extension's screen in Settings) or `panel`. `entry` is an
  `.html` file under `ui/`; scripts and styles are files too (no inline script runs). `bridge`
  is `{ allow[], host[] }`: `allow` lists the methods the page may call, `query:<id>` or
  `action:<id>`, each declared in `contributes.endpoint`; `host` lists helpers from `theme`,
  `locale`, `state` and `openNamzu` (opens one of Namzu's own screens).
- A **chip** is `{ id, states, opens? }`. Every sentence a chip can show is declared in
  `states` (`{ label, tone, icon?, showCount? }`); the process reports only a state id, never
  text. `opens` names a page of this extension. Desktop draws a chip only as the extension's state
  word in its row and on its screen in Settings, Extensions (while it runs); it is never drawn in the
  window's title band or on Namzu's tray icon.
- **Actions** (`contributes.endpoint.actions`, protocol `/2`) are the only calls a page can make
  that change anything: `{ id, paramsSchema, schema, maxBytes, purpose, changes, needsGesture? }`
  with `changes` one of `view`, `own-settings`, `own-data-delete`.

Rules: `U2` a page allows only methods the endpoint declares, `U3` a page is an `.html` file under
`ui/`, `U4` `usesNetwork` needs a host declared `for: ui`, `U5` a monitoring extension must carry
Namzu's own `builtin:what-is-collected` page, `U6` a page id may not be one of Namzu's own screens
(`notice`, `permissions`, `license`, `licence`, `install`, `remove`, `disable`, `consent`,
`indicator`), `U7` a page with the network cannot also call the extension (data or network, not
both), `U8` a chip opens only a page of this extension, `A1` actions need `/2`, and `K1` every file
a page, chip or icon names is in the package and signed, an SVG holds no script, no event
attribute, no `foreignObject` and no external reference. Titles and chip labels are the
extension's look and never count as wording: renaming a page never asks you again.

## Starting at sign-in (`background`)

`background` is `{ runAt: "signin", permission: "background.signin", defaultOn, indicator }` and
goes with the permission `background.signin` (rule `B1`: one without the other is refused).
`indicator` is `{ kind: "tray", label }` (the extension's own tray mark while Namzu is
closed, with its words) or `{ kind: "none" }`. The tray mark is optional and is the extension's own:
nothing an extension declares is ever drawn on Namzu's tray icon. One case requires it: an extension
that declares any permission with `personalData: true` and `background` **must** declare
`kind: "tray"` (rule `B2`: "a background extension that declares personal data must show its own tray
mark while it records; every other extension may have none"), and the runner stops it if its status
does not say the mark is shown. The label and the network host
purposes count as wording (a change needs a new notice version). See
[Extensions](extensions.md#start-at-sign-in-and-keep-running-when-namzu-is-closed).
