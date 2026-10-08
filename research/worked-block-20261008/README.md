# One "Worked for" block per reply (Desktop)

Proof for [Action rows](../../docs/cli/desktop.md#action-rows). `ref-27` is the old transcript (a clock in
every gap), `ref-28` and `ref-29` the reference: one block, no clock inside it, the time only under the answer.

Captured with Playwright Chromium on the dev preview: saved turns `/preview?activity=1`, a running turn
`/preview?live=1` (the scripted turn now stamps its events with the clock), long list `/preview?stress=300`.

| File | Shows |
| --- | --- |
| `a-saved-closed-*`, `b-saved-open-*` | restored turns closed, then all opened: narration, run group, rows, answer; no clock inside any block; one per reply under the answer (hover) |
| `c-live-running-*` | running: block open, "Working for 1s" |
| `d-live-finished-*` | the same turn after it ended: folded to "Worked for 12s", one clock on the answer |
| `e-live-reopened-*` | the person opened it afterwards: the choice is kept |
| `f-scroll-{up,mid,end}-{before,after}-*` | 360 px tall window; reader at top, mid-way and at the end while the block folds |
| `g-stress-*` | 300 turns, drawn as before |

Numbers (DOM count of `.message-time` outside the person's own message, per turn): saved turns 1 clock
per reply and 0 inside any block; live turn 0 while running, 1 after; open while running, folds on end;
reader at the top or mid-way keeps the same prompt position (166 and 86 px) and scrollTop (0 and 80)
across the fold; a reader at the end stays at the end.
