# The parent's narration band costs the rail nothing — real-TUI verification

Date: 2026-09-16

Drives the actual interactive TUI under a PTY at 100x24 (see
`tui-footer-order-drive.py` / `narration-band-cli.mjs`) on branch
`orch/ws7-narration`. The same scripted session runs twice — once where the
parent calls `narrate_work` twice, once where it does not — and the two rails
are compared. A scripted provider spawns two children sharing the workflow
"Release audit"; each runs `bash sleep 25` so both are still live when the
screen is captured.

**Result: PASSED.** With narration the rail keeps both agent rows, its title
and both borders; the rows the band added were paid for by the conversation
scrolling at the top. Order below the message frame is frame → footer →
narration → rail. No permission prompt.

24 rows is the size the question is about: at 30 rows the screen has slack
enough that no arrangement of these rows can be wrong.

## What is on screen, without narration

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

· Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
  PowerShell is available on PATH

· Permissions: Auto-approve edits for this session. Allow file edits; ask before shell commands and
  other changes.

 › Kick off the release audit workflow.
 Working (0.8s · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve edits (shift+tab to cycle) · …/namzu-narration-band-j7iS2g/workspace gpt-5.6-terra
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Release audit                                                  2 active · 2 total · ↓ / ctrl+t │
 │ ●  Scan release artifacts       0.0s · Working                               gpt-5.6-terra · 0 │
 │ ●  Verify release artifacts     -0.0s · Working                              gpt-5.6-terra · 0 │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## What is on screen, with two narration lines

```

· Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
  PowerShell is available on PATH

· Permissions: Auto-approve edits for this session. Allow file edits; ask before shell commands and
  other changes.

 › Kick off the release audit workflow.

 ∴ Both children are running in the background;
 Working (0.8s · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve edits (shift+tab to cycle) · …/namzu-narration-band-ujQgo4/workspace gpt-5.6-terra
   scan and verify are running in parallel; neither has reported yet
   scan found two unsigned artifacts — verify will re-check them first
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Release audit                                                  2 active · 2 total · ↓ / ctrl+t │
 │ ●  Scan release artifacts       0.0s · Working                               gpt-5.6-terra · 0 │
 │ ●  Verify release artifacts     -0.0s · Working                              gpt-5.6-terra · 0 │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The banner has scrolled off the top. The rail is whole: `Scan release
artifacts`, `Verify release artifacts`, the title and both borders.

## The same capture, read from buffer row 0

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

· Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
  PowerShell is available on PATH

· Permissions: Auto-approve edits for this session. Allow file edits; ask before shell commands and
  other changes.

 › Kick off the release audit workflow.

 ∴ Both children are running in the background;
 Working (0.8s · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve edits (shift+tab to cycle) · …/namzu-narration-band-ujQgo4/workspace gpt-5.6-terra
   scan and verify are running in parallel; neither has reported yet
   scan found two unsigned artifacts — verify will re-check them first
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Release audit                                                  2 active · 2 total · ↓ / ctrl+t │
 │ ●  Scan release artifacts       0.0s · Working                               gpt-5.6-terra · 0 │
```

Identical bytes, a different reading — and a false one. The VIEWPORT starts at
`buffer.active.baseY`; buffer row 0 is the oldest line of SCROLLBACK once the
screen has scrolled, so reading 24 lines from there shows the top of the
session with the bottom of the screen missing. That reads exactly like "the
last agent row fell below the fold", and it is where that claim came from.
`tui-footer-order-render.mjs` now reads from `baseY`, as
`packages/cli/src/tui/__tests__/support/screen.ts` always has; the buffer-top
reading is kept behind a flag only so the difference can be shown, as above.
