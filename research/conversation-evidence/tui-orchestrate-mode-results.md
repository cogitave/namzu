# Orchestrate mode + narration band, verified in the real TUI

Date: 2026-09-16

Scope: real interactive TUI under a PTY (`tui-orchestrate-mode-drive.py`, adapted from `tui-footer-order-drive.py`), at 100x30 and 40x30. Synthetic private workspace; scripted provider, no live model, no network.

## Issues

None.

## Observations (expected width-driven behavior, not a script fault)

- 40x30 orchestrate_on: orchestrate mode is ON but the footer shows no trace of it at this width: " shift+tab to cycle       gpt-5.6-terra"
- 40x30 after_model_switch: orchestrate mode survived the switch internally, but the footer still shows no trace of it at this width: " shift+tab to cycle        gpt-5.6-luna"

## 100x30

### effort picker open

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Select Reasoning Level for gpt-5.6-terra                                                   1/5 │
 │ ›1. default            [current] [default] Use the provider and model default                  │
 │  2. low                                    Fast responses with light reasoning                 │
 │  3. medium                                 Balance speed and reasoning depth                   │
 │  4. high                                   Deeper reasoning for complex problems               │
 │ ────────────────────────────────────────────────────────────────────────────────────────────── │
 │  5. orchestrate                            Off · highest level and delegate by default         │
 │ ↑↓ move · enter apply · esc back                                                               │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · …u-orchestrate-mode-HDe7EG/workspace ↑↓ / 1–9 select · enter apply · esc back













```

### orchestrate mode on (footer)

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH

 · Orchestrate mode is on — effort pinned to high for gpt-5.6-terra, and delegation guidance is
   strengthened for this session.

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort high · orchestrate · …-orchestrate-mode-HDe7EG/workspace gpt-5.6-terra
















```

### after model switch

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

· Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
  PowerShell is available on PATH

· Orchestrate mode is on — effort pinned to high for gpt-5.6-terra, and delegation guidance is
  strengthened for this session.

 · Model requested: gpt-5.6-luna. Checking available catalogues…

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH

 · Switched to codex · gpt-5.6-luna for this conversation.

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort high · orchestrate · …u-orchestrate-mode-HDe7EG/workspace gpt-5.6-luna









```

### narration budget (bounded, oldest dropped)

```
  PowerShell is available on PATH

· Orchestrate mode is on — effort pinned to high for gpt-5.6-terra, and delegation guidance is
  strengthened for this session.

· Model requested: gpt-5.6-luna. Checking available catalogues…

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH

 · Switched to codex · gpt-5.6-luna for this conversation.

 › Kick off the release audit workflow.

 ∴ Both children are running in the background;
 Working (0.5s · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort high · orchestrate · …u-orchestrate-mode-HDe7EG/workspace gpt-5.6-luna
   scan and verify are running in parallel; neither has reported yet
   scan found two unsigned artifacts — verify will re-check them first
   verify re-checked the two artifacts and both now pass
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Release audit                                                  2 active · 2 total · ↓ / ctrl+t │
 │ ●  Scan release artifacts       0.0s · Working                                gpt-5.6-luna · 0 │
 │ ●  Verify release artifacts     -0.0s · Working                               gpt-5.6-luna · 0 │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘

```

## 40x30

### effort picker open

```

∴ namzu  Cogitave v25.0.1
 · Computer use is unavailable on this
   device: Win32Adapter: neither
   PowerShell Core nor Windows
   PowerShell is available on PATH
 ┌────────────────────────────────────┐
 │ Select Reasoning Level for gp… 1/5 │
 │ ›1. default    [current] [default] │
 │     Use the provider and model de… │
 │  2. low                            │
 │     Fast responses with light rea… │
 │  3. medium                         │
 │     Balance speed and reasoning d… │
 │  4. high                           │
 │     Deeper reasoning for complex … │
 │ ────────────────────────────────── │
 │  5. orchestra…                     │
 │     Off · highest level and deleg… │
 │ ↑↓ move · enter apply · esc back   │
 └────────────────────────────────────┘
 … ↑↓ / 1–9 select · ↵ apply · esc back








```

### orchestrate mode on (footer)

```

∴ namzu  Cogitave v25.0.1
 · Computer use is unavailable on this
   device: Win32Adapter: neither
   PowerShell Core nor Windows
   PowerShell is available on PATH

 · Orchestrate mode is on — effort
   pinned to high for gpt-5.6-terra,
   and delegation guidance is
   strengthened for this session.

 ┌─ MESSAGE ──────────────────────────┐
 │ › Type a message… (/help for       │
 │   commands)                        │
 └────────────────────────────────────┘
 shift+tab to cycle       gpt-5.6-terra













```

### after model switch

```

∴ namzu  Cogitave v25.0.1
· Computer use is unavailable on this
  device: Win32Adapter: neither
  PowerShell Core nor Windows PowerShell
   is available on PATH

· Orchestrate mode is on — effort pinned
   to high for gpt-5.6-terra, and
  delegation guidance is strengthened
  for this session.

· Model requested: gpt-5.6-luna.
  Checking available catalogues…

 · Computer use is unavailable on this
   device: Win32Adapter: neither
   PowerShell Core nor Windows
   PowerShell is available on PATH

 · Switched to codex · gpt-5.6-luna for
    this conversation.

 ┌─ MESSAGE ──────────────────────────┐
 │ › Type a message… (/help for       │
 │   commands)                        │
 └────────────────────────────────────┘
 shift+tab to cycle        gpt-5.6-luna


```

### narration budget (bounded, oldest dropped)

```
  Checking available catalogues…

· Computer use is unavailable on this
  device: Win32Adapter: neither
  PowerShell Core nor Windows PowerShell
   is available on PATH

 · Switched to codex · gpt-5.6-luna for
    this conversation.

 › Kick off the release audit workflow.

 ∴ Both children are running in the
   background;
 Working (0.8s · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────┐
 │ › Type a message… (/help for       │
 │   commands)                        │
 └────────────────────────────────────┘
 shift+tab to cycle        gpt-5.6-luna
   scan and verify are running in pa…
   scan found two unsigned artifacts…
   verify re-checked the two artifac…
 ┌────────────────────────────────────┐
 │ Release audit                  2/2 │
 │ ● Scan release artifacts      0.0s │
 │ ● Verify release artifacts   -0.0s │
 └────────────────────────────────────┘

```

