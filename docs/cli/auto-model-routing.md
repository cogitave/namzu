---
type: Guide
title: Auto model routing
description: "model: auto and the routing block: how the CLI sizes a task with the decision model and picks the fast, default or big model, and why it always falls back to routing.default."
resource: packages/cli/src/integrations/decision/routing.ts
tags: [cli, config, decision, routing]
---

# Auto model routing

`model: auto` lets the CLI choose, per task, which of your configured models
runs it. A short chat can go to a small local model, an ordinary task to your
usual model, and a large multi-file change to a bigger one. It is off unless
you set it; without it the saved provider and model run every turn. See
[Choosing Auto](#choosing-auto) for the picker and `/model auto`.

It needs a [`decision` model](../sdk/decision.md) to size tasks. Both keys are
read from your user config (`~/.namzu/config.yaml`) or the managed file only.
A project's `namzu.config.json` and the environment cannot set them: they
choose which provider receives the conversation.

```yaml
model: auto
routing:
  default: { provider: anthropic, model: claude-sonnet-4 }   # required
  tiers:
    fast: { provider: ollama, model: gemma3:1b }
    big: { provider: anthropic, model: claude-opus-4 }
  strategy: yesno          # yesno (default) or score
  thresholds: { fast: 0.7, big: 0.7 }
  timeoutMs: 1500
```

`model: auto` without `routing.default` is refused when the config loads.

## How a task is placed

1. Local rules first, with no model call. A task in a conversation that has
   driven the desktop (called the computer-use tool recently), runs in a Pal, carries attachments or sits in a long conversation never goes to
   `fast` (small models are poor at multi-step tool use). A turn that follows a
   failed one moves up one tier: `fast` to `default`, `default` to `big`.
2. `yesno` asks two questions in parallel: is this simple enough for a small
   model (probability at least `thresholds.fast` selects `fast`), and does it
   need deep multi-step reasoning (at least `thresholds.big` selects `big`).
   `score` asks for one four-level rating and compares the probability mass of
   the low and high levels with the same thresholds.
3. Anything else runs on `routing.default`.

## It fails open to the default

No decision model, a failed or malformed answer, a timeout after `timeoutMs`
(default 1500 ms), an abort, contradictory answers, or a tier whose provider is
not available on this machine all run `routing.default`. A call that fails on
its own, as a pooled connection the service closed while idle does, is asked
once more inside the same budget. A failure never chooses `fast` (quality) or
`big` (cost). Each decision writes one debug log line with the tier, a short
reason and, on a fallback, the class of the error.

The default budget comes from measuring a hosted decision deployment: about
150–200 ms on a warm connection and 350–480 ms on the cold one most turns get
after an idle gap, so a 400 ms budget sent ordinary turns to the default.

## Where it applies

- **Top-level turns** in the terminal and `exec --json` are routed on the
  user's latest message. A routed turn has no fallback provider chain.
- **Delegated children** inherit the model the current turn was routed to.
- **Pals** resolve `auto` once, when the session starts, to `routing.default`
  (there is no task to size yet), and keep that model; a Pal never re-routes.
- An explicit choice wins: `--model` at launch turns Auto off for that launch,
  and picking a model by hand turns it off for that conversation until you
  choose Auto again.

## Choosing Auto

A `routing` block makes Auto **available**; `model: auto` makes it the
**default**. Routing alone is valid: Auto then appears as a choice but the saved
model runs until you pick it.

- **Terminal.** `/model` lists "Auto (picks a model for each task)" as its first
  row, and it is the row the picker opens on while Auto is on. `/model auto`
  (also `/model otomatik`, "switch model to auto", "auto'ya geç") does the same
  without opening the picker. The status line reads `Auto` while it is on, and
  after each turn the tier and model that turn went to, for example
  `Auto · fast · nemotron-3.5-lightning-free`. Auto
  chosen this way lasts for the launch and is not written to your saved model
  preferences; set `model: auto` in the config to make it the default every
  time.
- **Desktop.** When a `routing` block is configured, the composer's model
  picker shows an "Auto" row at the top and the model label reads "Auto" while it
  is on. Desktop remembers the choice for each conversation, and picking a model
  by hand in that conversation turns it off. Pal conversations and external
  engines (the native command-line engines) are not offered Auto: a Pal keeps its own
  model.
- **Without `routing`.** Asking for Auto says that it needs a `routing` block in
  your user config (`~/.namzu/config.yaml`) and points here; nothing changes.

The Desktop label shows `Auto`, not which model a turn used; the terminal's
status line and the per-decision debug log line name the tier.
