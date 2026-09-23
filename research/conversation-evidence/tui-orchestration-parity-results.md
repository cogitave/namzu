# Orchestration TUI parity, verified in the real TUI

Date: 2026-09-23

Scope: the two-phase, three-child colour prompt ("Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word. Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.") driven through the built CLI under a PTY by `tui-orchestration-parity-cli.mjs` and `tui-orchestration-parity-drive.py`, rendered through a fresh headless VT emulator (`tui-footer-order-render.mjs`). A `--import` preload replaces the provider with a scripted one: the parent launches two background explore agents in one response, waits for both, launches one join agent, and answers. The children answer Blue, Green and a sentence after 2.6 s, 3.8 s and 2.0 s. Orchestrate mode is turned on in the effort picker first, and each agent launch is approved with `y`.

- **Before**: `origin/main` at 92270560 (namzu 28.1.0).
- **After**: `feat/orchestration-tui-parity`.
- **Reference**: the Claude Code capture of the same prompt (auto mode, medium effort; its Phase 2 was interrupted by the capturing harness).
- **Real model**: one run of the branch with the owner's codex / gpt-5.6-luna configuration, orchestrate on, prompt mode.

Frames were captured at 120x40, 100x30, 80x24 and 40x30; the excerpts below are 120x40 unless named, with the boot notices left out.

## What changed on screen

| | Before | After |
|---|---|---|
| Launch | nothing in the conversation | `● Launched 2 agents · <workflow> / <phase>` with a `├`/`└` tree |
| Live agents | boxed rail, `N active · N total` | borderless tree, `⎿ activity` under each running agent |
| Rail during a review | hidden | header line kept (unit-tested; no agent was live during a review in this scenario) |
| Completion | `✓ X · Completed · ctrl+t · agent details` | `✓ X · 2.7s · 9.0k tokens · ctrl+o result · ctrl+t details`, answer attached |
| Turn end | nothing | `✻ Worked for 9.9s · 3 agents` |
| Effort picker | vertical list, `7. orchestrate` below a rule | slider ending in `┆ orchestrate`, `max + delegate by default` |
| Orchestrate indicator | footer `· orchestrate` only | also on the message box's top border |
| Settled rows | column 0 and column 1 mixed (2 to 5 rows per capture) | all at column 1 at every size |
| Prompt echo | `› Delegate this to subag` / `ents in two phases…` (the model received the split too) | one sentence, as typed |

Found and fixed on the way: settled rows were laid out as wide as the terminal rather than the transcript, so they wrapped two columns wider than live rows; and a row written while the parent's sentence was still streaming could settle first, which at 80x24 printed the Phase 2 launch receipt twice and never printed "Phase 1 returned Blue and Green".

## Findings that did not change

- **The waiting line never appears in a real run, before or after.** Every tool event of a batch, `wait_for_task`'s `tool_executing` included, reaches the TUI only after the whole batch finishes: `packages/sdk/src/runtime/query/iteration/phases/tool-review.ts` awaits `executeBatch` and drains the queued events afterwards. The running row is added and removed in the same tick. The same holds for any long tool (`Bash(sleep 12)` in the task-checklist PTY run): no live tool row is ever drawn under `Working`. The folded `✻ Waiting for N agents to finish` line is unit-tested and will show once the kernel streams tool events during a batch.
- Every agent launch is still reviewed in prompt mode, read-only ones included.


## Effort picker

**Reference**

```text
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔ ◐ medium · /effort ▔
   Effort
                             Faster                                                 Smarter
                             ──────────▲────────────────────────────────┆──────────────────
                             low     medium     high     xhigh      max       ultracode
                                                                          xhigh + workflows
   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
```

**Before**

```text
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Select Reasoning Level for gpt-5.6-luna                                                                        7/7 │
 │  1. default            [current] [default] Use the provider and model default                                      │
 │  2. low                                    Fast responses with light reasoning                                     │
 │  3. medium                                 Balance speed and reasoning depth                                       │
 │  4. high                                   Deeper reasoning for complex problems                                   │
 │  5. xhigh                                  Very deep reasoning for hard problems                                   │
 │  6. max                                    Maximum reasoning depth offered by this model                           │
 │ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────── │
 │ ›7. orchestrate                            Off · highest level and delegate by default                             │
 │ ↑↓ navigate · PgUp/PgDn jump · Home/End · 1–9 select · enter apply · esc back                                      │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · …/orch-parity/runs/before-120x40-EEmCu9/workspace        ↑↓ / 1–9 select · enter apply · esc back
```

**After**

```text
  Select Reasoning Level for gpt-5.6-luna
                               Faster                                              Smarter
                               ──────────────────────────────────────────────┆──────▲─────
                               default   low   medium   high   xhigh   max   ┆ orchestrate
                                                                               max + delegate by default
    Spends the most tokens and time; use it for work that splits into independent parts.
  ←/→ adjust · 1–9 select · enter apply · esc back
 shift+tab to cycle · …/orch-parity/runs/after-120x40-qSiGeZ/workspace ←/→ adjust · 1–9 select · enter apply · esc back
```

## Phase 1 running

**Reference (t=4 s)**

```text
     and testing
❯ Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
  Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
● Running 2 agents…
   ├ Name a colour · 0 tool uses
   │ ⎿  Initializing…
   └ Name another colour · 0 tool uses
     ⎿  Initializing…
✽ Metamorphosing… (3s · ↓ 86 tokens)
  ⎿  Tip: Use git worktrees to run multiple Claude sessions in parallel.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent
```

**Before**

```text
 › Delegate this to subag
   ents in two phases. Phase 1: two agents in parallel, each names one colour in a single word. Phase 2: one agent
   joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Starting Phase 1 with two tiny agents in parallel.
 Working (1.7s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/before-120x40-EEmCu9/workspace         gpt-5.6-luna
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Two-phase colour sentence                                                          2 active · 2 total · ↓ / ctrl+t │
 │ ●  Choose first colour          1.0s · Working                                                        gpt-5.6-luna │
 │ ●  Choose second colour         1.0s · Working                                                        gpt-5.6-luna │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**After**

```text
 › Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Starting Phase 1 with two tiny agents in parallel.
 ● Launched 2 agents · Two-phase colour sentence / Phase 1 (ctrl+t to manage)
   ├ Choose first colour
   └ Choose second colour
 Working (1.7s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/after-120x40-qSiGeZ/workspace          gpt-5.6-luna
 ● Two-phase colour sentence · 2 running · ↓ / ctrl+t
   ├ ● Choose first colour          1.0s                                                                   gpt-5.6-luna
   │   ⎿ Working
   └ ● Choose second colour         1.0s                                                                   gpt-5.6-luna
       ⎿ Working
```

## One agent finished, the other still running

**Before**

```text
 › Delegate this to subag
   ents in two phases. Phase 1: two agents in parallel, each names one colour in a single word. Phase 2: one agent
   joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Starting Phase 1 with two tiny agents in parallel.
 ✓ Choose first colour · Completed · ctrl+t · agent details
 Working (3.1s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/before-120x40-EEmCu9/workspace         gpt-5.6-luna
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Two-phase colour sentence                                                          1 active · 2 total · ↓ / ctrl+t │
 │ ●  Choose second colour         3.0s · Working                                                        gpt-5.6-luna │
 │ ✓  Choose first colour          2.7s · Completed                                               gpt-5.6-luna · 9.0k │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**After**

```text
 › Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Starting Phase 1 with two tiny agents in parallel.
 ● Launched 2 agents · Two-phase colour sentence / Phase 1 (ctrl+t to manage)
   ├ Choose first colour
   └ Choose second colour
 ✓ Choose first colour · 2.7s · 9.0k tokens · ctrl+o result · ctrl+t details
 Working (3.1s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/after-120x40-qSiGeZ/workspace          gpt-5.6-luna
 ● Two-phase colour sentence · 1 running · ↓ / ctrl+t
   ├ ● Choose second colour         3.0s                                                                   gpt-5.6-luna
   │   ⎿ Working
   └ ✓ Choose first colour          2.7s                                                            9.0k · gpt-5.6-luna
```

## Turn end

**Reference**

```text
❯ Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
  Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
● 2 background agents launched (↓ to manage)
   ├ Name a colour
   └ Name another colour
● Phase 1 is running: two agents are each naming a colour. When both reply, I'll start Phase 2 to join the colours into
  one sentence.
✻ Waiting for 2 background agents to finish
› Message from @a5ffb55c1a6027fa3 (ctrl+o to expand)
› Message from @a51f96276e760e602 (ctrl+o to expand)
  ⎿  Interrupted · What should Claude do instead?
● Agent "Name a colour" finished · 11s
● Agent "Name another colour" finished · 15s
● Phase 1 finished and the two agents picked Blue and Green. You interrupted before Phase 2 started, so no agent has
  joined them into a sentence yet. Should I run Phase 2 now?
✻ Cogitated for 23s · done 2:20 AM
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ yes, run phase 2
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
```

**Before**

```text
· Orchestrate mode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this
  session.
› Delegate this to subag
  ents in two phases. Phase 1: two agents in parallel, each names one colour in a single word. Phase 2: one agent joins
  the two colours into one short sentence. Keep every agent tiny and report the sentence.
∴ Starting Phase 1 with two tiny agents in parallel.
 ✓ Choose first colour · Completed · ctrl+t · agent details
 ✓ Choose second colour · Completed · ctrl+t · agent details
 ∴ Phase 1 returned Blue and Green; starting Phase 2.
 ✓ Join the two colours · Completed · ctrl+t · agent details
 ∴ Blue and green sit side by side.
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/before-120x40-EEmCu9/workspace         gpt-5.6-luna
```

**After**

```text
 · Orchestrate mode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this
   session.
 › Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Starting Phase 1 with two tiny agents in parallel.
 ● Launched 2 agents · Two-phase colour sentence / Phase 1 (ctrl+t to manage)
   ├ Choose first colour
   └ Choose second colour
 ✓ Choose first colour · 2.7s · 9.0k tokens · ctrl+o result · ctrl+t details
 ✓ Choose second colour · 3.9s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Phase 1 returned Blue and Green; starting Phase 2.
 ● Launched Join the two colours · Two-phase colour sentence / Phase 2 (ctrl+t to manage)
 ✓ Join the two colours · 2.1s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Blue and green sit side by side.
 ✻ Worked for 9.9s · 3 agents
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/after-120x40-qSiGeZ/workspace          gpt-5.6-luna
```

**After, Ctrl+O**

```text
 ✓ Choose first colour · 2.7s · 9.0k tokens · ctrl+o result · ctrl+t details
 ✓ Choose second colour · 3.9s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Phase 1 returned Blue and Green; starting Phase 2.
 ● Launched Join the two colours · Two-phase colour sentence / Phase 2 (ctrl+t to manage)
 ✓ Join the two colours · 2.1s · 9.0k tokens · ctrl+o result · ctrl+t details
  ▏ Blue and green sit side by side.
 ∴ Blue and green sit side by side.
 ✻ Worked for 9.9s · 3 agents
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-parity/runs/after-120x40-qSiGeZ/workspace          gpt-5.6-luna
```

## 80x24 and 40x30 (after)

**80x24, turn end**

```text
   ├ Choose first colour
   └ Choose second colour
 ✓ Choose first colour · 2.7s · 9.0k tokens · ctrl+o result · ctrl+t details
 ✓ Choose second colour · 3.9s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Phase 1 returned Blue and Green; starting Phase 2.
 ● Launched Join the two colours · Two-phase colour sentence / Phase 2 (ctrl+t
   to manage)
 ✓ Join the two colours · 2.1s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Blue and green sit side by side.
 ✻ Worked for 9.9s · 3 agents
 ┌─ MESSAGE ──────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                     │
 └────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/workspace       gpt-5.6-luna
```

**40x30, phase 1 running**

```text
 › Delegate this to subagents in two
   phases. Phase 1: two agents in
   parallel, each names one colour in a
    single word. Phase 2: one agent
   joins the two colours into one short
    sentence. Keep every agent tiny and
    report the sentence.
 ∴ Starting Phase 1 with two tiny
   agents in parallel.
 ● Launched 2 agents · Two-phase colour
    sentence / Phase 1 (ctrl+t to
   manage)
   ├ Choose first colour
   └ Choose second colour
 Working (1.7s · esc to interrupt)
 ┌─ MESSAGE ──────────── orchestrate ─┐
 │ › Type a message… (/help for       │
 │   commands)                        │
 └────────────────────────────────────┘
 shift+tab to cycle · orchestrate
 ● Two-phase colour sentence · 2/2
   ├ ● Choose first colour         1.0s
   │   ⎿ Working
   └ ● Choose second colour        1.0s
       ⎿ Working
```

## Real model (branch, codex / gpt-5.6-luna, orchestrate on, prompt mode)

Run once, before the two settled-row fixes. gpt-5.6-luna launched both Phase 1 agents in one response this time; namzu 28.0.0's run launched them one response apart. Two reviews were answered: the driver pressed Enter on the Phase 2 review twice because its first press landed inside the review's consent window. Wall time 33.3 s. Both agents again picked Blue, so the answer is "Blue and Blue are both colours." The agents finished between two snapshots, so the rail is not in these frames.


**Phase 1 review**

```text
 · Orchestrate mode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this
   session.
 › Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Phase 1:
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Start 2 agents                                                                                                     │
 │   Two-colour sentence / Phase 1                                                                                    │
 │   ├─ [ 1. Pick one colour · read-only · background ]                                                               │
 │   └─ [ 2. Pick another colour · read-only · background ]                                                           │
 │                                                                                                                    │
 │ ❯ 1. Start these 2 agents                                                                                          │
 │   2. Start and allow all tools for this session                                                                    │
 │   3. Do not start                                                                                                  │
 │ ↑↓ select · enter confirm · y / a / n answer · d full instructions                                                 │
 │ esc decline · ctrl+c decline and stop the turn                                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/orch-ref/nz-work-after       ↑↓ select · enter confirm · esc decline
```

**Final screen**

```text
 · Orchestrate mode is on — effort pinned to max for gpt-5.6-luna, and delegation guidance is strengthened for this
   session.
 › Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ Phase 1: I’m delegating two tiny color picks in parallel.
 ● Launched 2 agents · Two-colour sentence / Phase 1 (ctrl+t to manage)
   ├ Pick one colour
   └ Pick another colour
 ✓ Pick one colour · 1.7s · 9.0k tokens · ctrl+o result · ctrl+t details
 ✓ Pick another colour · 2.4s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Phase 1 is still resolving; I’m collecting both tiny results before starting Phase 2.
 ∴ Phase 2: I’m sending both results to one tiny agent to form the sentence.
 ● Launched Join the colours · Two-colour sentence / Phase 2 (ctrl+t to manage)
 ✓ Join the colours · 3.4s · 9.1k tokens · ctrl+o result · ctrl+t details
 ∴ Blue and Blue are both colours.
 ✻ Worked for 32s · 3 agents
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …5761-8e8f-0a2351a21556/scratchpad/orch-ref/nz-work-after gpt-5.6-luna
```
