---
type: Reference
title: Composer triggers
description: Words typed into the interactive composer that name one namzu action for that message — the hypermode keyword and save-as-skill phrases in English and Turkish — how they are matched, shown, dropped with Alt+W, what they change about the turn, and the composerTriggers config key that turns them off.
resource: packages/cli/src/tui/triggers/registry.ts
tags: [cli, tui, composer, skills, hypermode, config]
status: stable
generated: { by: process:claude-code, at: 2026-09-24T00:00:00Z }
---

# Composer triggers

A composer trigger is a word or phrase you type into the interactive
composer that names one namzu action for the message you are writing. While
it is armed, its words are highlighted, one row above the input says in words
what will happen, and **Alt+W** drops it. Nothing is hidden from you: the row
is there before you press Enter.

```text
┌─ MESSAGE ───────────────────────────────────────────────────────────────────────┐
│ ✦ hypermode · this turn: effort xhigh, delegate to parallel agents · alt+w drop │
│ › hypermode ile şu repodaki TODO'ları iki agent'a bölerek say▏                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

Three rules hold for every trigger:

- **Only your own keystrokes in this composer arm one.** A paste, a burst of
  text that arrives in one read (what a paste without bracketed-paste markers
  looks like), a recalled prompt (↑, Ctrl+R), a restored draft (Esc Esc), text
  from the external editor (Ctrl+G), a yank (Ctrl+Y) and an accepted
  completion only *suggest*. A loop, a picker, a scheduled run, `namzu exec`,
  `drain`, ACP, a resident step and a sub-agent never carry a trigger at all:
  `namzu exec "hypermode …"` is prose.
- **A trigger is a shorthand for something namzu already does.** It grants
  nothing and skips no confirmation: no trigger changes the permission mode,
  a directory, a credential, the sandbox, the tools or a limit.
- **Your words reach the model and the session log unchanged.** namzu's own
  words for a trigger travel beside them as request-only context — after the
  history, never in it, and never in the system prompt, which is the cached
  prefix.

## The triggers

| Trigger | You type | Default | What it does |
| --- | --- | --- | --- |
| `hypermode` | the word `hypermode` at the start or end of a clause | arms | For this turn only: effort pinned to `xhigh` (or the highest level below it the model publishes), and namzu tells the model to delegate independent work to parallel agents (the one-turn form of [`/hypermode`](slash-commands.md#hypermode)). |
| `save-skill` | "save this as a skill", "turn it into a skill", "bunu skill olarak kaydet", "bunu skill'e çevir", "bundan bir skill yap" … | arms | After the turn, if it completed and did tool work, runs exactly `/skills save` ([Learning from a task](skills.md#learning-from-a-task)). |
| `schedule` | "schedule this", "run it every day", "bunu her sabah çalıştır" … | suggests | Armed with Alt+W: namzu asks the model to propose a job with the `schedule` tool, which you confirm on screen ([Scheduled tasks](scheduled-tasks.md)). |
| `max-effort` | "think as hard as you can", "en yüksek eforla düşün" | off | Armed: effort pinned to the model's highest published level (`max` where there is one) for this turn. |

The hypermode phrases "delegate this to subagents", "use subagents for this",
"bunu alt ajanlara dağıt" and "bunu alt ajanlarla yap" arm it too.

A message that is **only** a save-as-skill phrase (and words like `please`,
`lütfen`, `bunu`) runs `/skills save` instead of being sent, and the row says
so (`runs /skills save`). A message that is only `hypermode` has no task: it is
not sent, and a row says to put the task in the same message.

## How words are matched

Matching is local and deterministic: no model call. Text is folded (case,
accents, `ı`/`İ`) before it is compared, so `KAYDET`, `kaydet` and `Kaydét`
are one word; the highlight still lands on the characters you typed.

- **A keyword arms only at the edge of its clause**: first or last word
  (`hypermode fix the flaky test`, `fix the flaky test, hypermode`). In the
  middle of a clause it is talk about the word and only suggests
  (`mesela hypermode yazınca farklı gözüküyor`). `hypermode'u` is a
  different word.
- **An English phrase arms between clause edges**; a Turkish phrase, whose
  verb comes last, has to end at one. A clause ends at `. ; ! ? … , :`, a
  bracket, a newline, an en or em dash, or a hyphen with space on both sides;
  `and`, `then`, `also`, `ve`, `sonra`, `ardından`, `ayrıca` and `bir de` count
  as edges too. A hyphen inside a word (`e-posta`, `sub-agents`) is not one.
- **A question is not a request** unless it asks for one. In a clause ending
  with `?`, a match arms only with `please`, `can/could/would/will you`, or a
  polite Turkish form (`kaydeder misin`, `kaydedebilir misin`, `kaydedelim mi`).
  "what is hypermode?" and "how do I fix this and save it as a skill?" only
  suggest; "hypermode, can you split this?" arms.
- **A phrase followed by `:` is a label**, not a request.
- **Negation cancels.** An English `not`, `don't`, `never`, `no`, `without` (and
  the like) up to three words before a phrase cancels it, except "don't
  forget to". Turkish negative verbs (`kaydetme`, `kaydetmeyin`, `kaydetmeden`)
  are never in the verb table, so they cannot match.
- **Talk about the word is not the word.** `hypermode` next to `keyword`,
  `mode`, `command`, `kelimesi`, `modu`, `komutu` … only suggests.
- **Nothing inside these matches at all:** code (`` `…` `` and fenced
  blocks), quotations (`"…"`, `“…”`, `«…»`, `‘…’`, and `'…'` where the quote
  stands at a word edge, so `skill'e` is not a quote), URLs, `@mentions`,
  paths and file names, and lines that start with `>`. An opening quote or
  backtick with no closer excludes everything after it.
- **A line that starts with `/`, `!` or `#` is a command** and is never
  read (after leading spaces, as the submit path reads it).
- A loose match — every content word in one clause, in any order
  (`kaydet bunu skill olarak`, `bunu skille çevir`) — only suggests.
- A draft longer than 65,536 characters is not read; the row says
  `✧ triggers paused: draft too long`.

## The tag row

One row inside the message frame, above the input, in the place of the
`Effort:` and `Model:` previews. `✦` marks an armed trigger and `✧` anything
else, and the state is always also a word or a mark, never only the glyph:

```text
✦ hypermode · this turn: effort xhigh, delegate to parallel agents · alt+w drop
✦ hypermode · enter steers without it · tab: new turn with it · alt+w drop     (a turn is running)
✦ save as skill · after this turn, if it did work; you confirm the file · alt+w drop
✦ save as skill · enter: after the running turn · tab: after the next · alt+w drop
✦ save as skill · runs /skills save · alt+w drop                                (the whole message)
✧ hypermode? · alt+w arms                                                       (a suggestion)
✧ hypermode (off) · alt+w restores                                             (dropped)
✧ save as skill · unavailable in plan mode
✦ hypermode (effort xhigh) · ✦ save as skill · alt+w drop                       (several)
```

The full copy needs a terminal of 84 columns (the row has the terminal's width
less the frame's four cells). Narrower terminals get shorter copy:
`✦ hypermode · this turn, effort xhigh · alt+w` from 64 columns (an 80×24
terminal shows this one), `✦ hypermode · effort xhigh · alt+w` from 44, and
`✦ hypermode` below that; several triggers are counted (`✦ 2 armed · alt+w`,
`✦ 1 armed · 1 off`). It is always one row, and the state word stays at every
width (`✧ hypermode?`, `✧ hypermode (off)`).

The effort the row names is the level hypermode pins on the model in use:
`xhigh`, also on a model that publishes `max`, and `high` on one whose menu
stops there.

The armed words are drawn bold and underlined in the trigger colour (sky,
ANSI 117), a colour of their own: violet stays the session mode's. With colour
off (`NO_COLOR`) the row still says everything. After you send, a line under
your message in the transcript names what it carried —
`✦ hypermode (this turn, effort xhigh)` — and the queue line names armed
triggers of queued messages (`⏎ 1 message queued — sending when ready · ✦
save as skill`). The footer keeps showing the session's own effort: a
one-turn pin does not change it.

## Keys

- **Alt+W** (Option+W on macOS, where the terminal sends Option as Meta)
  acts on the trigger nearest the cursor: it drops an armed one, restores a
  dropped one, and arms a suggestion. Typing inside a dropped trigger's words
  forgets the decision and reads them again.
- **Backspace** right after an armed `hypermode` drops it first and deletes
  nothing; the next Backspace deletes as usual.
- **Esc** is not used: it interrupts a running turn and clears an idle draft,
  as before.

## Enter, Tab and a running turn

Enter never changes where a message goes. Idle, Enter or Tab starts a new turn
with every armed trigger. While a turn runs, **Tab** queues the message with
its triggers, and **Enter** steers it into the running turn as always: a
save-as-skill in it binds to that running turn and runs when it ends; a
hypermode or schedule in it does not apply to a turn already under way, and
the row said so before you pressed Enter.

## What happens after the turn

A save-as-skill runs `/skills save` — exactly the prompt the command sends,
at the front of the queue, ahead of anything you queued with Tab — only when
all of these hold when the turn ends:

- the turn completed (it was not cancelled, stopped, paused or failed);
- it did tool work;
- it did not already save a skill;
- saving is still possible now (not `plan` or `strict` mode, and the
  `skill-creator` skill is available).

Otherwise one row says why (`save as skill · not run: the turn did no tool
work · /skills save runs it anyway`), and nothing else happens. The proposal
to save a multi-step task is not printed for a turn whose save you asked for.
Availability is checked again when a queued message's turn starts: a trigger
that can no longer apply says so (`hypermode · not applied: already on for
this session`).

## Cost

namzu's context text for a trigger is about 60 to 120 tokens on each model
call of that turn, sent after the history so the cached prefix is untouched.
Pinning the effort for one turn changes a request parameter, which on some
providers invalidates the cached conversation for that turn and the next.

## Turning it off

One switch turns every trigger off: `/config triggers off` writes
`composerTriggers.enabled: false` to your user config and applies to the
session at once (`/config triggers on` turns it back on, `/config triggers`
lists what is in force; `/config` has a row for it too). Or write it
yourself:

```yaml
# ~/.namzu/config.yaml
composerTriggers:
  enabled: true          # the one switch
  suggest: true          # show suggestions (loose matches, pasted or recalled text)
  languages: [en, tr]    # whose phrases are matched
  builtin:
    hypermode: arm       # arm | suggest | off
    save-skill: arm
    schedule: suggest
    max-effort: off
```

**A repository cannot turn triggers back on.** The layers combine key by key,
and the project file (`namzu.config.json`), or a profile it declares, can
only turn things down: switch the feature off, lower a trigger from `arm` to
`suggest` or `off`, or narrow the languages. It cannot switch the feature on
over your user file, raise a trigger, or add a language. The user file, a
profile your user file declares and the managed file set values as usual. The
key is never read from the environment. A wrong key or value refuses to load,
as every config key does (`composerTriggers.enabeld` names itself).

## Where it lives

`packages/cli/src/tui/triggers/`: `registry.ts` (the triggers and their
effects), `verbs.ts` (the Turkish verb forms), `fold.ts`, `analyze.ts`,
`pattern.ts` and `detect.ts` (matching), `provenance.ts` (which characters
you typed), `copy.ts` (the row), `context-text.ts` (namzu's words to the
model) and `setting.ts` (`/config triggers`). The config shape and merge rule
are `packages/cli/src/config/composer-triggers.ts`. Only files under
`packages/cli/src/tui/` import the matcher; a test holds that.
