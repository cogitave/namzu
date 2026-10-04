---
type: Reference
title: The model catalogue refresh
description: How every CLI launch refreshes the Zen and Zen Go model catalogue in the background, where the last-good copy lives, what happens when the refresh fails, and the modelCatalogueRefresh key that turns it off.
resource: packages/cli/src/integrations/providers/zen-catalogue.ts
tags: [cli, providers, zen, config]
status: stable
---

# The model catalogue refresh

Zen and Zen Go add and reprice models on their own schedule. `@namzu/zen`
ships a bundled catalogue and never goes to the network for it by itself (see
[Zen and Zen Go](../sdk/zen.md)). The CLI does go to the network: every launch
refreshes the catalogue in the background, so the model picker and routing
follow upstream without waiting for a new release.

## When it runs

Every launch that opens agent sessions starts one refresh: the interactive TUI
(`namzu`, `namzu resume`), `namzu exec` (with or without `--json`), `namzu acp`,
`namzu drain` and `namzu resident run`. A background resident runner
(`namzu resident start`) is a separate forked process, and it starts its own
refresh when it begins. Other commands (`doctor`, `login`, `state`, `eval`,
`resident status` and the rest) open no session and start none.

`drain` and the resident runner are on the list because they continue turns
another launch started. A turn that parked on a model only the live or last-good
catalogue carries would otherwise be continued on the bundled catalogue alone,
where that model has no known wire format. The last-good copy always comes from
the application home (`NAMZU_HOME`), including when `drain --store` names a
different one.

- **It never delays startup.** The launch starts the refresh and carries on;
  nothing on the startup path waits for it
  (`packages/cli/src/__tests__/zen-catalogue-refresh-at-launch.test.ts` shows
  the TUI coming up while the network has not answered).
- **It is bounded.** Each of the five source reads has 15 seconds, and the
  whole refresh 30 seconds (`ZEN_CATALOGUE_REFRESH_BUDGET_MS`). Each source also
  has a byte limit, and a source past it is refused rather than cut short.
- **It is cancelled on exit.** When the command returns, a refresh still in
  flight is aborted. A short `namzu exec` usually ends first, and that is not
  counted as a failure.

The sources are the ones the bundled catalogue is generated from: Zen's and
Go's documentation pages on OpenCode's `dev` branch, `https://models.dev/api.json`,
and each service's own `/models` answer. The rules that read them are the same
code as well (`packages/providers/zen/src/catalogue/`). The Go page currently
repeats its indented price table in tabs; the parser accepts matching copies
and refuses conflicting prices. Gateway-verified route exceptions take
precedence over a stale endpoint cell for the exact affected models.

## What the session uses

1. On launch the session starts with the **bundled** catalogue. The refresh
   first reads the **last-good copy** at `cli/zen-catalogue.json` under the
   application home (`~/.namzu` or `NAMZU_HOME`), and uses it if it is valid.
2. When the refresh **lands**, its catalogue becomes the one the session uses
   straight away: for the model picker, anonymous-access checks, routing,
   context windows and effort levels. That includes providers built before it
   landed, because each lookup reads the current catalogue. It is then written
   as the new last-good copy, to a temporary file first and then renamed into
   place.
3. When the refresh **fails** (a source unreachable, too slow, too large, or no
   longer in the shape the rules read), the session keeps what it had: the
   last-good copy, otherwise the bundled catalogue. It logs one `warn` line
   saying which one it kept and why.

The catalogue is used whole or not at all. A half-written, edited or
wrong-version copy on disk is refused with one `warn` line and ignored, never
read in part. A saved catalogue carrying a now-reviewed omitted model, one
of the superseded Go routes, or a direct-anonymous flag on a model the
gateway currently refuses is also rejected. An offline launch then uses the
corrected bundle. A derivation that
meets any source it cannot read in full produces no catalogue.

An id a service serves that no source gives a wire format for is not offered:
the model picker, `/model` and the model tool leave it out, even when the
bundled catalogue once carried it. `@namzu/zen` lists such an id for hosts that
can name a protocol, and the CLI has no setting that names one, so choosing it
could only fail. No wire is guessed for it. A `model:` in the config that names
one fails its turn with the driver's "no source states its wire format" error.

A model name that carries a control, format or line-separator character is a
source the refresh refuses, as is a last-good copy holding one, so no upstream
text can write terminal escape sequences through the picker.

## Desktop catalogue and selection

The desktop ACP catalogue projects the driver's listed models through the
same access and wire checks. It never inserts the CLI's registry default or a
saved model absent from those rows. An unavailable selected model stays in
provider status and receives a catalogue notice, so a refresh cannot silently
change the conversation's route. Failed, unsupported and timed-out listings
return an empty row list with distinct notices; credential rejection uses a
fixed authentication notice without exposing the remote diagnostic.
The strict account-listing method is used when a driver provides one. In
particular, the account driver no longer turns an API rejection into its
bundled offline menu on this desktop path. A refreshable admitted credential
is read from its exact owner and renewed within the listing's existing budget.
A typed rejected subscription refresh grant receives the same authentication
notice as an explicit provider credential rejection. TLS and other transport
failures do not establish that the login is invalid and retain a catalogue
loading notice.

Provider selection is checked before replacing an existing model session.
Selecting a paid Zen model without a Zen account credential is refused while
the previous conversation remains usable. A fresh ACP conversation can select
an eligible free Zen model before any unavailable saved provider is prepared.
The anonymous route remains experimental; successful selection does not verify
that the gateway will accept inference.

## Turning it off

```yaml
# ~/.namzu/config.yaml
modelCatalogueRefresh: false
```

Or `NAMZU_MODEL_CATALOGUE_REFRESH=0` (`1`, `true`, `0` and `false` are
accepted; anything else refuses to start). Absent means on. Off means the
bundled catalogue alone: no network read and no last-good copy. The refresh
starts before a project is trusted, so the key is read from the user config
(and a profile it declares), managed config and the environment; a
`namzu.config.json` in the working directory does not affect it.
