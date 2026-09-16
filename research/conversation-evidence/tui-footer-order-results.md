# TUI footer order and rail title — real-TUI verification

Date: 2026-09-16

Drives the actual interactive TUI under a PTY (see `tui-footer-order-drive.py` / `tui-footer-order-cli.mjs`) against fix commit `03f5483a`. Scripted provider spawns two children sharing workflow "Release audit" via a background `Agent` tool call; each runs `bash sleep 20` so it is still live when the screen is captured.

**Result: PASSED**

## Frames

### composer_ready

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · /tmp/namzu-tui-footer-order-Lhk4KA/workspace                    gpt-5.6-terra



















```

### idle_mode_on

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH

 · Permissions: Auto-approve edits for this session. Allow file edits; ask before shell commands
   and other changes.

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve edits (shift+tab to cycle) · …amzu-tui-footer-order-Lhk4KA/workspace gpt-5.6-terra
















```

### two_live_agents

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

 · Computer use is unavailable on this device: Win32Adapter: neither PowerShell Core nor Windows
   PowerShell is available on PATH

 · Permissions: Auto-approve edits for this session. Allow file edits; ask before shell commands
   and other changes.

 › Kick off the release audit workflow.

 ∴ Started the Release audit workflow. Scan and Verify are both running in the background;
 Working (0.8s · esc to interrupt)

 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                         │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘
 ⏵⏵ Auto-approve edits (shift+tab to cycle) · …amzu-tui-footer-order-Lhk4KA/workspace gpt-5.6-terra
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Release audit                                                  2 active · 2 total · ↓ / ctrl+t │
 │ ●  Scan release artifacts       0.0s · Working                               gpt-5.6-terra · 0 │
 │ ●  Verify release artifacts     -0.0s · Working                              gpt-5.6-terra · 0 │
 └────────────────────────────────────────────────────────────────────────────────────────────────┘






```

### cockpit

```

█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █
█ ▀█ █▀█ █ ▀ █ █▄ █▄█  Cogitave v25.0.1

 ⏵⏵ Auto-approve edits (shift+tab to cycle)       agents — enter inspect · left phases · esc return
 ┌────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Release audit                                                               2 active · 2 total │
 │ Select a phase, then inspect a child.                                                          │
 │                                                                                                │
 │ Phases · 1/2                   │ Agents · 1/1                                                  │
 │ › ● 1 Scan                 0/1 │ › ● Scan release artifacts     Working · 0.8s    gpt-5.6-terra│
 │   ● 2 Verify               0/1 │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
 │                                │                                                               │
```

## Assertions checked

- `idle_mode_on`: the row directly under the message frame's bottom border carries the
  mode badge and the `shift+tab to cycle` hint (footer text: ` ⏵⏵ Auto-approve edits (shift+tab to cycle) · …amzu-tui-footer-order-Lhk4KA/workspace gpt-5.6-terra`).
- `two_live_agents`: that same footer row is unchanged, and the row directly under IT is the
  rail's own top border (` ┌────────────────────────────────────────────────────────────────────────────────────────────────┐`) — never a rail drawn between the
  frame and the footer.
- The rail's title line is ` │ Release audit                                                  2 active · 2 total · ↓ / ctrl+t │` — the shared
  workflow label ("Release audit"), never the literal "Delegated work".
- The cockpit's title line (opened with ctrl+t) is ` │ Release audit                                                               2 active · 2 total │`.
- Build stability: dist files hashed before/after the run were IDENTICAL.

