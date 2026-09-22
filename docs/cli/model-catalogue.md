---
type: Reference
title: The model catalogue refresh
description: How every CLI launch refreshes the Zen and Zen Go model catalogue in the background, where the last-good copy lives, what happens when the refresh fails, and the modelCatalogueRefresh key that turns it off.
resource: packages/cli/src/integrations/providers/zen-catalogue.ts
tags: [cli, providers, zen, config]
status: stable
generated: { by: process:claude-code, at: 2026-09-22T00:00:00Z }
---

# The model catalogue refresh

Zen and Zen Go add and reprice models on their own schedule. `@namzu/zen`
ships a bundled catalogue and never goes to the network for it by itself (see
[Zen and Zen Go](../sdk/zen.md)). The CLI does go to the network: every launch
refreshes the catalogue in the background, so the model picker and routing
follow upstream without waiting for a new release.

## When it runs

The interactive TUI (`namzu`, `namzu resume`), `namzu run`, `namzu run-stream`
and `namzu acp` each start one refresh when they launch. Other commands
(`doctor`, `login`, `state`, `eval` and the rest) start none.

- **It never delays startup.** The launch starts the refresh and carries on;
  nothing on the startup path waits for it
  (`packages/cli/src/__tests__/zen-catalogue-refresh-at-launch.test.ts` shows
  the TUI coming up while the network has not answered).
- **It is bounded.** Each of the five source reads has 15 seconds, and the
  whole refresh 30 seconds (`ZEN_CATALOGUE_REFRESH_BUDGET_MS`). Each source also
  has a byte limit, and a source past it is refused rather than cut short.
- **It is cancelled on exit.** When the command returns, a refresh still in
  flight is aborted. A short `namzu run` usually ends first, and that is not
  counted as a failure.

The sources are the ones the bundled catalogue is generated from: Zen's and
Go's documentation pages on OpenCode's `dev` branch, `https://models.dev/api.json`,
and each service's own `/models` answer. The rules that read them are the same
code as well (`packages/providers/zen/src/catalogue/`).

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
read in part. A derivation that meets any source it cannot read in full
produces no catalogue.

An id a service serves that no source gives a wire format for is shown in the
picker as `<id> (no known wire format)`. Choosing it fails with a message
asking for an explicit protocol, and no wire is guessed.

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
