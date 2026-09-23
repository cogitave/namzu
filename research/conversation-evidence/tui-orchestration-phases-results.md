# Orchestration by phase, and read-only launches unasked, in the real TUI

Date: 2026-09-23

Scope: the same two-phase colour prompt as `tui-orchestration-parity-results.md`, driven through the built CLI under a PTY by `tui-orchestration-phases-cli.mjs` and `tui-orchestration-parity-drive.py` (which gained a `key_if` step), rendered through a fresh headless VT emulator. The scripted provider launches two background `explore` agents for Phase 1 in one response, waits for both, then launches one **general-purpose** agent for Phase 2, so the run exercises a launch that can only read and one that can write. Orchestrate mode is turned on in the effort picker first; the driver presses `y` on a review only when one is on screen.

- **Before**: `feat/orchestration-tui-parity` at `0a394539`.
- **After**: the same branch with read-only launches started without a review in `prompt` mode, phases on the rail and in the cockpit, and the closing line's phase count and spend.
- **Reference**: the reference terminal's run of the same prompt with its script-driven workflow tool (auto mode; one workflow, three agents).
- **Real model**: one run of the after build with the owner's codex / gpt-5.6-luna configuration, orchestrate on, `prompt` mode, in a fresh scratch directory.

Frames were captured at 120x40, 80x24 and 40x30; excerpts are 120x40 unless named, with the boot notices left out.

## What changed

| | Before | After | Reference |
|---|---|---|---|
| Read-only launch in `prompt` mode | "Start 2 agents" review | starts; the rail is up at once | not asked (auto mode) |
| Launch that can write | review | review | not asked (auto mode) |
| Rail while Phase 2 runs | Phase 2's agent only | `✓ Phase 1 · 2/2 · 4.0s`, then `● Phase 2 · 0/1` with its agent | one line per workflow |
| Rail header | `1 running · ↓ / ctrl+t` | `1 running · 2/3 done · 6.5s · 18.0k tokens · ↓ / ctrl+t` | `2/3 agents done · 10s · ↓ 40.4k tokens` |
| Cockpit opens on | the first phase | the phase still working | the first phase |
| Cockpit header | `1 active · 3 total` | `2/3 agents done · 1 running · 7.8s · 18.0k tokens`, then `3/3 agents · 9.5s · 27.0k tokens · done` | `3/3 agents · 12s · done` |
| Agent pane title | `Agents · 1/2` | `Phase 2 · 1 agent` | `Name colours · 2 agents` |
| Phase row | `✓ 1 Phase 1   2/2` | `✓ 1 Phase 1   2/2 · 4.0s` | `✔ Name colours 2/2` |
| Closing line | `✻ Worked for 12s · 3 agents` | `✻ Worked for 11s · 3 agents in 2 phases · 27.0k tokens` | `✻ Crunched for 20s · done 9:15 AM`, after `● Dynamic workflow "…" completed · 12s` |
| Wide cockpit row | last cell on the frame's padding (`9.0k│`) | one blank cell before the border | — |

Kept from namzu: the per-batch launch receipt and per-agent completion rows with their collapsed answers (the reference writes one workflow line and a completion line); `✓`/`✗` and the status word in the cockpit; the drill-in transcript with the prompt, every tool row and the answer in order.

## Not adopted, and why

- **One rail line per workflow.** The reference can draw a whole workflow on one line because its script knows every agent up front. namzu's parent launches phase by phase, so the rail draws what exists: finished phases folded to one line, the live phase expanded.
- **`Prompt` / `Activity` / `Outcome` sections in the agent view.** namzu's drill-in already shows the prompt (`›`), each tool row and the final answer (`∴`) in that order; three labels would cost three rows on a 24-row screen and add nothing that is not already on it.
- **Right/Left to drill in and out.** namzu's cockpit uses ←/→ to move between panes and Enter to open an agent; changing that would change what those keys do.
- **Terminal tab title.** The reference sets a live title (`◐ <short label>`). namzu writes to the terminal outside its frame only when the operator opts in, and only content-free text (`tui.notifications`); a title carrying a model-written workflow label needs the same opt-in and sanitising, so it is left for a change of its own.
- **Wall-clock time in the closing line** (`done 9:15 AM`): namzu prints no clock times anywhere else.
- **A `/workflows` list and "save".** D5: namzu has no workflow scripts; Ctrl+T and `/agents` are the workflow view.

## Phase 1

**Before: two read-only launches wait on a review**

```text
 › Delegate this to subagents in two phases. Phase 1: two agents in parallel, each names one colour in a single word.
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Start 2 agents                                                                                                     │
 │   Two-phase colour sentence / Phase 1                                                                              │
 │   ├─ [ 1. Choose first colour · read-only · background ]                                                           │
 │   └─ [ 2. Choose second colour · read-only · background ]                                                          │
 │ ❯ 1. Start these 2 agents                                                                                          │
 │   2. Start and allow all tools for this session                                                                    │
 │   3. Do not start                                                                                                  │
 │ ↑↓ select · enter confirm · y / a / n answer · d full instructions                                                 │
 │ esc decline · ctrl+c decline and stop the turn                                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …efore-120x40-4Tuyza/workspace ↑↓ select · enter confirm · esc decline
```

**After: they start, and the rail is up at once**

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
 shift+tab to cycle · effort max · orchestrate · …/workspace         gpt-5.6-luna
 ● Two-phase colour sentence · 2 running · 0.0s · ↓ / ctrl+t
   ├ ● Choose first colour          0.0s                                                                   gpt-5.6-luna
   │   ⎿ Working
   └ ● Choose second colour         0.0s                                                                   gpt-5.6-luna
       ⎿ Working
```

## Phase 2 running

**Reference (≈10 s in; one line per workflow under the footer)**

```text
──────────────────────────────────────────────────────────────────────────────────────────────────────────── ultracode ─
❯
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
  ◯ colour-sentence  Two agents each name a colour, then one agent joins them … 2/3 agents done · 10s · ↓ 40.4k tokens
```

**Before**

```text
 Working (1.2s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/workspace        gpt-5.6-luna
 ● Two-phase colour sentence · 1 running · ↓ / ctrl+t
   └ ● Join the two colours         1.0s                                                                   gpt-5.6-luna
       ⎿ Working
```

**After**

```text
 Working (1.2s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/workspace         gpt-5.6-luna
 ● Two-phase colour sentence · 1 running · 2/3 done · 6.5s · 18.0k tokens · ↓ / ctrl+t
   ✓ Phase 1 · 2/2 · 4.0s
   ● Phase 2 · 0/1
     └ ● Join the two colours       1.0s                                                                   gpt-5.6-luna
         ⎿ Working
```

**After: the Phase 2 agent can write, so it is still asked about**

```text
 ✓ Choose second colour · 3.9s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Phase 1 returned Blue and Green;
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Start an agent                                                                                                     │
 │   Two-phase colour sentence / Phase 2                                                                              │
 │   └─ [ 1. Join the two colours · files + commands ]                                                                │
 │ ❯ 1. Start this agent                                                                                              │
 │   2. Start and allow all tools for this session                                                                    │
 │   3. Do not start                                                                                                  │
 │ ↑↓ select · enter confirm · y / a / n answer · d full instructions                                                 │
 │ esc decline · ctrl+c decline and stop the turn                                                                     │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …after-120x40-gftLZc/workspace ↑↓ select · enter confirm · esc decline
```

## The cockpit

**Reference (`/workflows` after the run)**

```text
   colour-sentence
   Two agents each name a colour, then one agent joins them into a sentence                 3/3 agents · 12s · done
   ╭ Phases ──────────────┬ Name colours · 2 agents ──────────────────────────────────────────────────────────────╮
   │   ✔ Name colours 2/2 │  ✔ colour-1     Haiku 4.5 · 20.2k tok                                              4s │
   │   ✔ Join         1/1 │ ❯✔ colour-2     Haiku 4.5 · 20.2k tok                                              6s │
```

**Before (Ctrl+T while Phase 2 runs)**

```text
 shift+tab to cycle · effort max · orchestrate · …/workspace          agents — enter inspect · left phases · esc return
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Two-phase colour sentence                                                                       1 active · 3 total │
 │ Select a phase, then inspect a child.                                                                              │
 │ Phases · 1/2                         │ Agents · 1/2                                                                │
 │ › ✓ 1 Phase 1                    2/2 │ › ✓ Choose first colour               Completed · 2.7s   gpt-5.6-luna · 9.0k│
 │   ● 2 Phase 2                    0/1 │   ✓ Choose second colour              Completed · 3.9s   gpt-5.6-luna · 9.0k│
 │ ←→ pane · ↑↓ navigate · PgUp/PgDn jump · enter select · esc return                                                 │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**After (Ctrl+T while Phase 2 runs)**

```text
 shift+tab to cycle · effort max · orchestrate · …/workspace          agents — enter inspect · left phases · esc return
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Two-phase colour sentence                                        2/3 agents done · 1 running · 7.8s · 18.0k tokens │
 │ Select a phase, then inspect a child.                                                                              │
 │ Phases · 2/2                         │ Phase 2 · 1 agent                                                           │
 │   ✓ 1 Phase 1             2/2 · 4.0s │ › ● Join the two colours             Working · 2.3s            gpt-5.6-luna │
 │ › ● 2 Phase 2             0/1 · 2.3s │                                                                             │
 │ ←→ pane · ↑↓ navigate · PgUp/PgDn jump · enter select · esc return                                                 │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**After (Ctrl+T once the turn has ended)**

```text
 shift+tab to cycle · effort max · orchestrate · …/workspace          agents — enter inspect · left phases · esc return
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Two-phase colour sentence                                                  3/3 agents · 9.5s · 27.0k tokens · done │
 │ Select a phase, then inspect a child.                                                                              │
 │ Phases · 1/2                         │ Phase 1 · 2 agents                                                          │
 │ › ✓ 1 Phase 1             2/2 · 4.0s │ › ✓ Choose first colour              Completed · 2.7s   gpt-5.6-luna · 9.0k │
 │   ✓ 2 Phase 2             1/1 · 4.1s │   ✓ Choose second colour             Completed · 3.9s   gpt-5.6-luna · 9.0k │
 │ ←→ pane · ↑↓ navigate · PgUp/PgDn jump · enter select · esc return                                                 │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Turn end

**Reference**

```text
u
  Get to finished work sooner with Opus 5.5. Switch anytime with /model.
❯ /effort
  ⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration
❯ Use a workflow for this. Phase A: two agents in parallel, each names one colour in a single word. Phase B: one agent
  joins the two colours into one short sentence. Keep every agent tiny (use the haiku model) and report the sentence.
● Workflow(Two agents each name a colour, then one agent joins them into a sentence)
  ⎿  /workflows to view dynamic workflow runs
  ⎿  Allowed by auto mode classifier
● The workflow is running in the background:
```

**Before**

```text
 ∴ Phase 1 returned Blue and Green; starting Phase 2.
 ● Launched Join the two colours · Two-phase colour sentence / Phase 2 (ctrl+t to manage)
 ✓ Join the two colours · 4.1s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Blue and green sit side by side.
 ✻ Worked for 12s · 3 agents
```

**After**

```text
 ∴ Phase 1 returned Blue and Green; starting Phase 2.
 ● Launched Join the two colours · Two-phase colour sentence / Phase 2 (ctrl+t to manage)
 ✓ Join the two colours · 4.1s · 9.0k tokens · ctrl+o result · ctrl+t details
 ∴ Blue and green sit side by side.
 ✻ Worked for 11s · 3 agents in 2 phases · 27.0k tokens
```

## Smaller terminals

**After, 80x24, Phase 2 running**

```text
 shift+tab to cycle · effort max · orchestrate · …/workspace       gpt-5.6-luna
 ● Two-phase colour sentence · 1 running · 2/3 done · ↓ / ctrl+t
   ✓ Phase 1 · 2/2 · 3.9s
   ● Phase 2 · 0/1
     └ ● Join the two colours       1.0s                           gpt-5.6-luna
         ⎿ Working
```

**After, 40x30, Phase 2 running**

```text
 ● Two-phase colour sentence · 1/3
   ✓ Phase 1 · 2/2 · 4.0s
   ● Phase 2 · 0/1
     └ ● Join the two colours      1.0s
         ⎿ Working
```

**After, 40x30, Ctrl+T while Phase 2 runs**

```text
 agents — ↵ inspec… phases · esc return
 ┌────────────────────────────────────┐
 │ Two-phase colour sentence 2/3 done │
 │ Select a phase, then inspect a ch… │
 │ Phases · 2/2                       │
 │   ✓ 1 Phase 1           2/2 · 4.0s │
 │ › ● 2 Phase 2           0/1 · 2.3s │
 │ Phase 2 · 1 agent                  │
 │ › ● Join the two c… Working · 2.3s │
 │ ←→ pane · ↑↓ · enter · esc return  │
 └────────────────────────────────────┘
```

## Real model (codex / gpt-5.6-luna, orchestrate on, `prompt` mode)

No review was opened: the model chose `explore` for all three agents, so every launch started without asking. It launched the two Phase 1 agents one response apart again, so the phase took 10 s from first start to last finish though each agent ran 2–3 s. Both agents picked Blue. Turn wall time 79.3 s, almost all of it the parent model at max effort.

**Real model, Phase 1 starting ([t=40.8s]), no review was opened**

```text
   Phase 2: one agent joins the two colours into one short sentence. Keep every agent tiny and report the sentence.
 ∴ I’ll run the two colour picks in parallel, then pass both exact words to one tiny joining agent.
 ✓ Tasks · 0/2 done
   ■ Gather two colours
   □ Join colours into a sentence
 ● Launched Pick first colour · Two-phase colour sentence / Phase 1: choose colours (ctrl+t to manage)
 Working (41s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/nz-work gpt-5.6-luna
 ● Two-phase colour sentence · 1 running · 0.0s · ↓ / ctrl+t
   └ ● Pick first colour            0.0s                                                                   gpt-5.6-luna
       ⎿ Working
```

**Real model, Phase 2 running ([t=67.3s])**

```text
   ✓ Gather two colours
   ■ Join colours into a sentence
 Working (1m7s · esc to interrupt)
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/nz-work gpt-5.6-luna
 ● Two-phase colour sentence · 1 running · 2/3 done · 27s · 18.0k tokens · ↓ / ctrl+t
   ✓ Phase 1: choose colours · 2/2 · 10s
   ● Phase 2: join colours · 0/1
     └ ● Join the colours           0.0s                                                                   gpt-5.6-luna
         ⎿ Working
```

**Real model, final screen**

```text
 ✓ Pick first colour · 2.1s · 9.0k tokens · ctrl+o result · ctrl+t details
 ● Launched Pick second colour · Two-phase colour sentence / Phase 1: choose colours (ctrl+t to manage)
 ✓ Pick second colour · 2.6s · 9.0k tokens · ctrl+o result · ctrl+t details
 ✓ Tasks · 1/2 done
   ✓ Gather two colours
   ■ Join colours into a sentence
 ● Launched Join the colours · Two-phase colour sentence / Phase 2: join colours (ctrl+t to manage)
 ✓ Join the colours · 3.0s · 9.1k tokens · ctrl+o result · ctrl+t details
 ✓ Completed · Join colours into a sentence
   ✓ Gather two colours
   ✓ Join colours into a sentence
 ∴ Blue and Blue are colours.
 ✻ Worked for 1m19s · 3 agents in 2 phases · 27.1k tokens
 ┌─ MESSAGE ──────────────────────────────────────────────────────────────────────────────────────────── orchestrate ─┐
 │ › Type a message… (/help for commands)                                                                             │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 shift+tab to cycle · effort max · orchestrate · …/nz-work gpt-5.6-luna
```

**Real model, Ctrl+T after the turn**

```text
 shift+tab to cycle · effort max · orchestrate · …/nz-work  agents — enter inspect · left phases · esc return
 ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
 │ Two-phase colour sentence                                                   3/3 agents · 30s · 27.1k tokens · done │
 │ Select a phase, then inspect a child.                                                                              │
 │ Phases · 1/2                         │ Phase 1: choose colours · 2 agents                                          │
 │ › ✓ 1 Phase 1: choose col… 2/2 · 10s │ › ✓ Pick first colour                Completed · 2.1s   gpt-5.6-luna · 9.0k │
 │   ✓ 2 Phase 2: join colo… 1/1 · 3.0s │   ✓ Pick second colour               Completed · 2.6s   gpt-5.6-luna · 9.0k │
 │ Two independent agents each return   │                                                                             │
 │ exactly one colour word.             │                                                                             │
 │ ←→ pane · ↑↓ navigate · PgUp/PgDn jump · enter select · esc return                                                 │
```

Found and not changed: in this run the Phase 2 launch receipt was not yet in the conversation while its agent ran (the rail showed it); it appeared once the agent finished. In the scripted run, where the launch was reviewed, it appeared while the agent ran.
