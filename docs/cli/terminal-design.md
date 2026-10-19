---
type: Reference
title: Terminal design
description: Namzu's visual identity, reading order and interaction boundaries in the terminal.
resource: packages/cli/src/tui/App.tsx
tags: [cli, tui, design, accessibility]
status: stable
---

# Terminal design

Namzu uses neutral text with phosphor-green accents on the terminal's own
background. A two-row block-letter wordmark carries the opening identity, with a muted
version beside it and, on the row under the version, the working folder
(home written as `~`, cut from the left to fit, as a coding agent's welcome
header does; the footer no longer names it). Terminals narrower than 48 columns or shorter than 20 rows
use the compact `∴ namzu` signature. The header is printed once
into native scrollback. Provider and tool details remain available through
`/status` and `/status tools`. A normal startup does not add a redundant
connection message to the conversation; explicit provider/model changes still
receive confirmation. Switching models does not repeat the project-instructions
notice when the loaded file list is unchanged. A newly loaded non-empty list is
announced; instruction loading itself still runs for the replacement session.
The composer owns the empty-conversation typing hint. Colors use
explicit ANSI 256-color indices so the green accent and neutral text do not
shift hue through RGB-to-palette approximation. Terminals with color disabled
retain the same text, symbols and boundaries.

Namzu's own terminal labels use words and text-presentation marks, never emoji.
Emoji code points can occupy two terminal cells and crowd the following label,
especially in Windows Terminal. Scheduled jobs therefore start with the job
name in `/schedule`, and new run titles use `Scheduled: <job> · <time>`;
previously saved clock-prefixed titles display with the same text prefix in
conversation lists and notices without rewriting stored sessions.

## The composer footer

One line sits directly below the composer's lower rule, with no blank row between
them. It follows the reference terminal agent's item order and wording; its
items are joined by a dim ` · `, left to right:

```text
⏵⏵ bypass permissions on · PR #607 · 3 shells · esc to interrupt · ← 1 agent · ↓ to manage   model
```

- **The mode**, as `<mark> <words> on` in the mode's color, then a dim
  `(shift+tab to cycle)` when Shift+Tab actually cycles it here and no
  background shell is running (as in the reference, a running task takes the
  reminder off the row). `auto` reads `⏵⏵ bypass permissions on` in the error
  color, `accept-edits` reads `⏵⏵ accept edits on` in the user accent, `plan`
  reads `‖ plan mode on` in teal, `strict` reads `‖ preapproved only on` in the
  warn color. The default mode (`prompt`) has no item: the row shows a quiet
  `shift+tab to cycle` only when nothing else would be on it.
- **The pull request** for the current branch, `PR #592`: a dim `PR` and the
  number underlined, as an OSC 8 link to the pull request where the terminal
  supports links (plain text elsewhere), colored by review state: approved
  green, changes requested red, awaiting review yellow, merged purple, draft
  dim. It is hidden on `main`, `master`, the repository's default branch, and
  outside a git repository. A missing `gh` shows a dim `install gh for PR
  status`; a signed-out `gh` shows `gh auth login for PR status`; any other
  failure, and a branch with no pull request, show nothing.
- **Background shells**, a cyan pill `1 shell` / `N shells`. It replaces the
  separate `N shells running` line that used to sit under the footer, and it
  hides with the composer surface (a permission or child view owning the
  screen).
- **The reasoning effort**, when the operator has set one, as `effort <level>`
  (Namzu's own item; the reference has none).
- **`esc to interrupt`**, dim, while a turn runs (omitted when the right side
  already carries a hint that names Esc).
- **`← N agent(s)`**, dim, when `←` from an empty composer would open the agents
  and N of them are running (agents plus workflow runs; capped at `99+`). It
  shows while a turn runs and while idle, and only with nothing typed, pasted
  or attached, no panel open and the rail not focused, so the row never names
  a key that does nothing.
- **`↓ to manage`**, dim, when `↓` from an empty composer reaches something: a
  running shell or a row on the agents rail. Same conditions as the agents
  hint.

On the right: an interaction hint or a durable goal when either is active, else
the model identity. The working directory is no longer on this row.

The keys the hints name:

- **`↓`** from an empty composer focuses the footer. The shell pill comes
  first (drawn inverted, with `↓ to manage` turning into `enter to view
  shells`); Enter opens the same
  `Background` screen `/jobs` opens. `↓` again moves into the agents rail (`main`,
  then the agents, then the workflows) and `↑` from its first row moves back
  to the pill. With no shells the first `↓` lands on the rail, and with no
  rows either it opens the agents cockpit, as before. Esc or any other key
  hands the keyboard back to the composer.
- **`←`** from an empty composer opens the agents cockpit (`/agent`). With
  anything typed, pasted or attached, or with Shift/Ctrl/Alt held, it is cursor
  movement as always.

The footer is always exactly one row. On narrow screens it drops, in order: the
model on the right, `↓ to manage`, `← N agents`, `esc to interrupt`, the cycle
reminder, the effort label, the shell pill, the pull request item, the quiet
reminder, and only then does the mode truncate. Whole items go, never half of
one (the reference clips its row at the edge, which can show half a word).
Where no composer is on screen (a picker, the trust prompt, a stopped start) the
footer leaves out the cycle reminder, since Shift+Tab is the composer's key; the
active mode stays. This single line replaces the permission-mode row that used
to appear inside the writing area, the separate status line below it, and the
shells line under that. Pending input and transient notices stay inside the
composer's rules, above the input.

Deliberate differences from the reference: the model identity (`Auto · fast ·
model` while Auto routing is on) stays on the right while it fits; `← N agents`
counts this session's running agents and workflows and `←` opens them, where the
reference counts other background sessions that wait for the person and `←`
sends the session itself to the background (a confirmation press and all);
there is no resting `← for agents` hint; and `↓ to manage` is not offered
with text typed, because `↓` is cursor movement then.

The pull request item is read off the render path by `tui/pr-status.ts`: `git
symbolic-ref` for the branch, then `gh pr view --json
number,url,state,isDraft,reviewDecision` for it, each with a 5 second timeout and
no prompt allowed. It first runs about half a second after the screen mounts,
again each time a turn ends (an agent may have switched branches), and then on a
slow ladder: 90 seconds while the operator is active, up to 30 minutes when
idle, stretched further for an answer that keeps coming back the same and for
repeated failures. It never runs while a turn is running, never in print or
exec mode (they do not mount this screen), and not at all when
`NAMZU_PR_STATUS=off` or the output is not a terminal.

While a turn runs, Enter steers a submitted message to that turn's next model
boundary; Tab holds it for the next turn. Messages typed while Namzu is working
are rows at the end of the transcript, directly above the working line (and
so above the input frame), not inside the frame: pending rows, then the send-now
hint, then `Working (…)`, then the input. Each is `❯ <text>` in the grey of a
message not yet read, one row per message in the order it will be used. A
Tab-queued row ends with a dim `· after this reply`, so it reads apart from a
steer. Under the last row a dim `ctrl+x ctrl+s to send now` appears while a
reply runs. Rows are bounded by the terminal height (five, three or one; the
rest fold into a dim `+N more messages` row) and counted in the transcript's
live-window budget so they do not overdraw a short terminal. Control
characters in a submitted message are escaped before display. When a steer is
delivered it becomes an ordinary user row carrying a dim `· sent while
working`.

With nothing typed, Up chooses the newest queued message the operator wrote
(automatic goal and peer items cannot be edited); the chosen row takes the
accent colour and the others lose their pointer. Up and Down move, Enter loads
the chosen message into the input with its attachments and armed triggers,
and Esc only leaves the choice. Typing anything else leaves it too. While
messages can be edited the input's placeholder reads `Press up to edit queued
messages`. Alt+Up still restores the newest one at once. A held queue says why
under its rows: after a failed reply `Paused after the failed reply · send a
message to run them`; after Esc, a new Enter message runs before the queue.
`ctrl+x ctrl+s` is a two-key chord (any key in between drops it) that does what
Esc does with a pending steer, interrupting the reply so the steer starts the
next one, and also releases a queue that Esc had held.

A running background shell shows as the footer's shell pill (above). The `/jobs` child view is the `Background` panel (no job ids on screen; rows read `<icon> <command>  running|done|error|stopped`, details are `Shell details`); a finished job also leaves a `● Background command "…" completed (exit code N)` row in the transcript. It keeps the input draft mounted, lets the
operator inspect bounded, escaped shell output, and stops a selected running
job on `x`. A new question from a tool closes the shell view so the question
is visible and answerable.

[Hypermode](slash-commands.md#hypermode), while on for the session, is named
once at the right end of the composer's upper rule in violet. The rule rests in
plain graphite. Turning the mode on sends one short lavender glow from the visible
rule's center toward both ends, then the rule becomes still again. Repeating
the selection does not replay it. Motion is skipped in non-interactive terminals,
for screen readers, and when colour is refused (`NO_COLOR`, `FORCE_COLOR=0`,
`TERM=dumb`); the label remains readable without colour. A frame too narrow for the
complete mode name omits the label rather than clipping it.

### Composer triggers

A [composer trigger](composer-triggers.md) — `hypermode`, "bunu skill olarak
kaydet" — gets one row inside the composer's rules, above the input, where the
`Effort:`/`Model:` previews go:
`✦ hypermode · this turn: effort xhigh, delegate to parallel agents · alt+w drop`.
The armed words in the draft are bold and underlined in sky (ANSI 117), the
trigger's own colour: violet belongs to the session mode, which lasts, and a
trigger lasts one message. The highlight is cut from the draft before unsafe
characters are escaped for the terminal, so it stays on the right cells. `✦`
(armed) and `✧` (suggested, dropped, unavailable) are one cell wide and are not
emoji, and the state is always also a word or mark (`?`, `(off)`,
`unavailable …`), so a terminal without colour, or a reader who cannot tell
the two glyphs apart, loses nothing. The row is one row at every width and
shortens by steps (full copy from 84 terminal columns, a short form from 64,
label and key from 44, the label alone below). The border and the footer are
unchanged by a trigger: a one-turn effort pin shows in the row and in the
transcript line under the message (`✦ hypermode (this turn, effort xhigh)`),
and the footer keeps the session's own effort. The queued-message heading names
armed triggers on taller terminals; a compact terminal prioritizes the next
message's text.

Every mark on this line and in the plan is a text-presentation character one
cell wide by Unicode's own width data: `⏵` (U+23F5) for modes that approve on
their own, `‖` (U+2016) for modes that hold. `⏸` (U+23F8), which the reference
terminal uses for the second, is an emoji code point; Windows Terminal draws it
as a blue two-cell tile, so this line does not use it.

Shift+Tab changes the mode and the footer is its whole reply, as it is in the
reference terminal: no transcript line is written, however many times it is
pressed. `/permissions`, a change asked for by name, still answers in the
transcript. The key works while a turn runs, and the change governs every
approval decision from that moment: the running turn's later tool calls, the
delegated turns that borrow its review, and the next message. An approval
dialog already on screen is decided under the mode it was asked under (the
composer, and so the key, is not live while one is open); entering plan mode
mid-turn refuses the next call that would change something, including one a
permission rule such as `permissions: { bash: 'allow' }` allows; leaving it
approves nothing already refused. Each change is written to the session log as
`approval_policy_changed` before anything is decided under it, and the model is
told once through the kernel's own notice. See [Slash commands](slash-commands.md#keys-that-are-not-commands).

Below the footer — not between it and the frame — comes whatever panel owns
the rest of the screen while agents are live: the automatic delegated-work
rail, the agent cockpit, a child transcript, or the tool-output viewer, each
in the same relative order they already had among themselves. The footer's
own row is fixed relative to the frame above it, never to whichever of those
panels follows, so it always reads immediately under the input regardless of
how much the rail or a full-screen surface below it is showing.
The agent cockpit's per-workflow header names its workflow by the label every
one of its agents shares; when they carry none, or carry more than one, it
shows a neutral count (`2 agents · 1 running`) rather than a generic name that
described none of them in particular. So does each row of the cockpit's own
workflow picker (`Ctrl+T` with two or more groups live or retained at once): a
group whose agents never set an explicit label is named after its own lead
agent instead of the generic default — that agent's title, plus a `+N` count
when the group holds more than one — so two unlabelled groups still read as
distinct entries rather than two identical rows.

The rail is a blank row, a `main` row, then one row per running agent (and a
failed or stopped one for 30 seconds), drawn right under the footer with no
title and no box:

```text

  ● main
  ◯ general-purpose  Reading the README                      2m10s · ↓ 12.3k tokens
  ◯ explore          Find where the footer is drawn  8s · ↓ 1.4k tokens · 2 queued
  ◯ general-purpose  Check the changelog                          waiting
```

The first cell of a row is the pointer slot (`❯` on the selected row) and the
bullet sits two cells in, directly under the first glyph of the footer line
above it; rows stop two cells short of the right edge. `●` marks the transcript
on screen and `◯` every other row; `main` is `●` until an agent is viewed. No
accent colour is used: the pointer and the bullets take the row's own colour,
and only a finished row's bullet is coloured — green when it succeeded, red
when it failed or was stopped. Each agent row is its type, a description and,
right-aligned, how long it has run and what it has spent so far
(`↑ 12.3k tokens` while it has only read its task, `↓ 12.3k tokens` from its
first tool call on, and nothing until it has reported usage); an agent
still waiting for a slot reads `waiting` instead of a clock, and messages sent
to it that it has not taken in yet read `N queued` in the warning colour. The
name column is as wide as the longest type or workflow name on screen, up to 28
cells, shared by agent and workflow rows. The description is the agent's
**live label** while one exists, else the sentence it was launched with:
every 30 seconds, while a background agent runs and has done something new
since the last time (and at least three messages' worth), it is asked once, on
its own model with no tools, to say in three to five words what it is doing
now, in the language of its task. Only one plain line of at most 100
characters is accepted; anything else is dropped and the old label stays. The
label goes when the agent ends, and agents inside a `workflow` run keep their
own labels. The cost of that request is not charged to the run's token
ledger (see the open questions). Rows follow launch order. Workflow and phase labels, model and
tool counts are not on the rail; the cockpit (`Ctrl+T`, `/agents`) and the
agent's own transcript carry them.

At most five agents are drawn. A longer list scrolls with the selection:
`↑ N more` appears on the right of the `main` row when agents are scrolled
above, and a dim `  ↓ N more` row sits under the last one when more are below;
with more than five agents and nothing below, an empty row keeps its place so
the block never changes height. A background agent that **completed** leaves
the rail at once (its answer is already in the conversation); one that failed or
was stopped stays 30 seconds, then leaves; saved agents from earlier sessions
never appear (the cockpit lists them). The agent on screen stays on the rail
however it ended.

The `main` row appears only beside at least one agent row (or while an agent
is viewed). A rail with nothing but a workflow row has no `main` row.

Press ↓ in an empty composer to move into the rail (with no rows on screen it
still opens the cockpit for saved agents). While the rail has the keys the
footer's mode line is **replaced** by a key line for the selected row, and the
rows stay where they are. An agent or workflow row reads
`Enter to view · x to stop` (`x to clear` once it has finished), plus
`ctrl+x ctrl+k to stop all agents` when more than one agent runs and the line
is at least 90 columns wide; `main` reads `↑/↓ to select · Enter to view`, and
the row already on screen reads `↑/↓ to select`. Esc is not advertised but
still hands the keyboard back to the composer, as does any other key. ↑/↓
moves between `main`, the agents and the workflows (a `❯` marks the row), Enter
on an agent views it (see below) and on `main` goes back to the conversation,
`x` stops a running agent (the parent turn and the other agents keep going) or,
on a finished one, clears its row, and `ctrl+x` then `ctrl+k` stops every
running agent. `Ctrl+T` still opens the cockpit from anywhere. While an
approval dialog is open the rail shrinks to the `main` row with a count
(`2 agents`) and names no key, since the dialog owns the keyboard.

**Viewing an agent** is not a separate screen. Enter on its row replaces the
live region of the conversation with that agent's transcript (its prompt and
what you sent it as `❯` rows, what it said as `●`, its tools folded) while the
one composer stays live, with the placeholder `Message @<type>…` (the type cut
at 20 cells). What you type is sent to that agent: a running agent queues it
for its next tool round (`N queued` on its row), a finished one is resumed from
its transcript, and one you stopped is refused in a plain sentence; your words
show at once in its transcript as `❯ text`. PgUp/PgDn/Home/End scroll it.

Keys while an agent is viewed follow the reference. **Esc** on a running agent
stops it and stays in the view (the row turns into a finished one; the footer
says `esc to interrupt`); on an agent that has ended it goes back to the
conversation, the draft stays in the composer, and the agent's row lingers 30
seconds. **Ctrl+C** stops a running agent and goes back either way, and also
interrupts the conversation's own turn if one is running. Enter on the `main`
row goes back without stopping anything.

**Slash commands typed in the view** are never the agent's when the host
answers them itself (every built-in). `/model` is refused with a notice
(`/model changes the main conversation's model, not this agent's`) and the text
stays in the composer; `/compact`, `/clear` and `/new` ask first
(`/compact acts on the main conversation, not this agent`, with `Cancel`
listed first and focused, and `Run /compact on the main conversation`); every
other built-in runs against the conversation as it does with no agent open.
Other text that starts with `/` (a skill, a custom command, a typo) is sent to
the agent as typed. An agent that cannot take messages (a saved child, a
workflow run's agent) keeps the read-only boxed screen described under the
cockpit; the reference does not view a workflow's agents in place either, only
in the workflow's detail.

Agents and workflows are separate. An agent the model gave a `workflow` label
is never an agent row: it exists only inside its workflow, which gets one row
after the agent rows (the rail lists only the unlabelled subagents above it):

```text
  ● main
  ○ general-purpose  Gorev a                                                1m05s
  ○ general-purpose  Gorev d                                       0.3s · ↓ 15 tokens
  ◯ Release audit    ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  3/7 · 2m14s · ↓ 48.2k tokens
```

A workflow here is the agents the model gave one explicit `workflow` label
(the kernel has no workflow object; unlabelled batches are only agents).
The row is `◯`, the label, a `▰▱` bar of settled agents out of all of them,
then `3/7 · elapsed · ↓ tokens` (the token segment waits for the first usage
report). It is dim until selected, and the bullet is coloured only by the
outcome: green when every agent completed, red when one failed or the
workflow was stopped — and already red while it runs once a member has failed.
The elapsed time ticks each second and freezes when the last agent settles; the
row leaves 30 seconds after that. Workflow rows are not windowed and share the
agents' name column. As the line narrows it gives up, in order, the
`n/m` counter, the elapsed time, the word `tokens`, then the bar shrinks from
20 to 12 to 8 cells; the name is squeezed last, never below eight cells.

↓ walks `main` (when drawn), the agents, then the workflows. On a workflow row
the key line is `Enter to view · x to stop` (`x to clear` once it has
finished). Enter opens the workflow's detail view and
`x` stops every agent of the workflow that is still going (each one as its own
`x` would), or clears a finished row.

The detail view is a frameless dialog: a rule across the top, the workflow's
name, then its description on the left and
`<done>/<total> agents · <elapsed>` on the right (with ` · done`, ` · stopped`
or ` · failed` once it has ended), then the lists. From 64 columns they sit side
by side in one box titled `Phases` (left) and `<phase> · N agents` (right);
below 64 columns one list is shown at a time. The left pane has one row per
phase in `phase_order` then first seen: the phase's number, which becomes a
green `✔` once all its agents are done or a red `✘` once it has settled with a
failure or a stop; the model's `phase` label verbatim; and right-aligned
`done/total` (total grows as agents are started, since Namzu cannot know a phase
before it has an agent). The right pane lists the selected phase's agents:
`✔` done, `✘` failed or skipped, `●` running or `◌` queued, the label, then
`model · tokens` and the elapsed time flush right. The selected phase's
`phase_detail` fills free rows of the right pane. The pointer is on the phases
until Enter or → moves it to the agents; Enter on an agent opens its
transcript. Esc or ← goes up a level, and from the phases back to the rail
row; `x` stops the whole workflow on the phases and skips or stops the one
agent on the agents. The box is 14 list rows tall on a tall terminal (fewer on
a short one, never under 4), whatever it holds. A list longer than its pane
says which rows it shows in the box's bottom border, dim and ending the pane's
segment: `↑ 3–16 of 16  ` on the agents pane (an arrow on the side that has
more, a space on the side that has not), likewise on the phases pane. Footer: phases
`↑↓ select · x stop workflow · esc back`; agents
`↑↓ select · enter view · x skip · esc back`.

```text
──────────────────────────────────────────────────────────────────────────────
 Surum denetimi
 Butun paketlerin surum notlarini tara               1/5 agents · 2m11s

 ╭ Phases ──────────────┬ Tarama · 3 agents ───────────────────────────────────╮
 │ ❯ ✔ Tarama       1/3 │ ✔ tara:cekirdek   gpt-5 · 9.0k tok             2.7s │
 │   2 Duzeltme     0/2 │ ● tara:arayuz     gpt-5 · 4.1k tok              11s │
 ╰──────────────────────┴──────────────────────────────────────────────────────╯
 ↑↓ select · x stop workflow · esc back
```

The `workflow` tool's runs use the same row and the same three levels, but are
driven by the run's own events rather than by the agents that happen to exist:
the count includes queued agents, a run with no agent yet already has its row,
and the phases the script declared in `meta.phases` are listed from the start in
the declared order, a phase nothing has started in shown dim with no count and
`Not started yet` on level 2. On a run `x` at level 1 stops the whole run and at
level 2 skips the one agent (`x to skip`), and a skipped agent does not fail its
phase. The header adds the run's purpose after its name and, once it has ended,
`· completed`, `· failed` or `· stopped`. At launch the conversation shows
`● Workflow(<purpose>)` over `⎿ Running in the background (↓ to manage)`, and
when the run ends, whatever the model is doing, `✓ Workflow <name> completed ·
<time> · <N> agents · <tokens>` (`✗ … failed`, `■ … stopped`). See
[Workflows in the CLI](workflows.md).

When the model launches labelled agents the conversation gets one group line,
`● Workflow Release audit` over `⎿ Running in background · ↓ to manage`,
instead of a launch row per agent, and no completion rows for them. When a
workflow is over it leaves one line in the conversation, above the
turn's `✻ Worked for …` line: `✓ Workflow Release audit completed · 4m02s · 7
agents · 112.0k tokens` (dim), `✗ … failed · … · 1 failed …` (red) or `■ …
stopped …` (yellow). "Over" means the parent turn that ran it has ended and
every member has settled, so a later phase that starts long after the previous
one finished does not produce a second line; the line is written once per
workflow label within a turn. Agents under the same label in a later turn are a
new run with their own row and their own line. Namzu has no workflow pause,
and the parent turn does not end while its agents still run, so there is no
paused bullet and no "waiting for N workflows" line.

Between the footer and the rail sits the parent's own narration, when it has
written any: up to three dim lines, one row each, unboxed and indented to the
column the rail's `main` label starts in, so they read as the parent talking rather
than as chrome the panel drew. They are commentary and carry no status —
status is on the rail below them, in counts and glyphs as everywhere else.
They never take a row from the rail: its height budget is computed from the
terminal's own rows and not from what is above it, so no agent row is traded
for a line of commentary. On a screen with no row to spare, the band's rows
are paid for the way every row this TUI adds is paid for — the frame grows and
the terminal scrolls, so the oldest conversation leaves at the top while the
rail stays whole at the bottom. Measured in a real terminal 24 rows tall, with
and without narration, by
`research/conversation-evidence/narration-band-cli.mjs`. A turn that narrates
nothing draws nothing here: no heading, no blank separator, no reserved row.
The band is drawn wherever the rail would be drawn, including between phases
when no child is live — which is when a line saying what comes next is worth
the row — and it is hidden by the same full-screen surfaces that hide the
rail.

## Delegated work in the conversation

Delegated work leaves three kinds of row in the conversation, each written once
and never redrawn; the live state belongs to the rail.

```text
● 2 background agents launched (↓ to manage)
  ├ Choose first colour
  └ Choose second colour
› Message from @general-purpose (ctrl+o to expand)
● Agent "Choose first colour" finished · 1m 4s
● Agent "Choose second colour" failed: Provider refused the request · 3s
✻ Worked for 38s · 3 agents · 27.0k tokens
```

Delegated work leaves these rows, each written once and never redrawn; the
live state belongs to the rail.

- **A launch receipt** per batch: the agents one model response launched
  together, each by its description under one line (`N background agents
  launched` when they all run in the background, else `Launched N agents`). A
  single agent is named inline. Agents the
  model gave a `workflow` label are one workflow and get one `● Workflow <name>`
  line instead (see the rail section), once per workflow. The receipt waits until
  the batch is whole, so agents launched in the same response share one
  receipt, and it is always written before any of its agents' completions.
  It is drawn below the reply that launched it even while that reply is still
  open: a reviewed batch's events reach the terminal only when the batch
  finishes, so the reply stays open for the whole of a foreground agent's run.
  An agent resumed by a later message gets no second receipt.
- **Two rows per agent that reports on its own.** First what it said, collapsed:
  `› Message from @<type> (ctrl+o to expand)` (the hint follows the sender in
  parentheses, after a space; the sender is the agent
  type, so two general agents both read `@general-purpose`). Ctrl+O opens the
  answer in place while the row is still in the live region; once it has
  settled into history, the press after the live bodies are open shows the
  newest settled body in the output viewer, where ←/→ reach the others. The
  answer is the child's text and is shown as text — terminal controls in it are
  displayed, never obeyed. Then one line that says it is over:
  `● Agent "<description>" finished · 1m 4s` (green), `failed: <reason> · 3s`
  (red; `Unknown error` when nothing says why) or `was stopped by user · 1s`,
  `was stopped by Namzu · 1s` (the conversation's own agent stopped it with
  `cancel_agent`), or plain `was stopped · 1s` when nobody recorded who
  (warning). The result is not repeated in that line and it carries no token
  count; an agent resumed by a later message writes the pair again when it ends
  again. Only an agent that runs on its own writes the pair: a background
  launch, one whose wait was released (the operator wrote while the parent
  waited) and one a later message resumed.
- **A waited-on agent writes the tool's own result instead.** An agent the
  parent waited on hands its result back inline, so there is no notification:
  the row is `● <type> (<description>)` over
  `⎿ Done (3 tool uses · 12.1k tokens · 8s)`. A failed or stopped one keeps the
  closing line above.
- **A message a running agent sent.** An agent can say something to the
  conversation while it works, with its own `send_message` tool (`to: "main"`);
  it is drawn as the same collapsed `› Message from @<type> (ctrl+o to expand)`
  row, and the model gets the text, framed as the agent's own words, with its
  next turn (an idle conversation wakes for it). It does not interrupt a wait
  the running turn is in.
- **A closing line** when a turn that launched agents settles: how long the
  turn took and how many agents it launched (phases are never counted here),
  what they spent when any reported it, and how many failed
  when one did. A turn that delegated nothing closes with its time alone,
  `✻ Worked for 46s`, when it finished normally and took three seconds or more;
  a quicker answer, or a turn that was stopped or cancelled (which already says
  how it ended), adds no line.

While the parent does nothing but wait on its agents, the per-call rows under
`Working` fold into one line, `✻ Waiting for 2 agents to finish` (or
`✻ Waiting for <name>` for one). A wait running beside other work keeps every
row.

After the work ends nothing folds up: the prose, receipts, completion rows,
final answer and closing line stay. The rail, the waiting line and the
narration band are live-only and leave when their work settles.

The new marks are text characters one cell wide by Unicode's width data, none
of them emoji: `●` U+25CF, `⎿` U+23BF, `✻` U+273B, `├ └ │`, and the slider's
`▲` U+25B2 and `┆` U+2506. `●` is East-Asian *ambiguous*, so a terminal set to
draw ambiguous characters wide draws it in two cells, as it already did on the
old rail. `⏺`, `✔` and `✳`, which the reference terminal uses in some builds,
are emoji code points Windows Terminal can draw as two-cell tiles, and are not
used.

## Compact tool activity

Successful built-in file reads, searches and file discovery share an `Explored` heading when consecutive. Each operation keeps its own row and retained output; `Ctrl+O` expands the output, and errors remain explicit ungrouped failures. The CLI `tool-end` event includes optional `output` containing retained tool text before preview formatting; the built-in event adapter supplies it. Background job reads and stops identify the action and job instead of displaying JSON arguments. Reading job output is not an interactive terminal wait or a write to stdin; those operations are not provided by the current job tool.

A read, search, write or edit that the kernel described in fields (`ToolResult.facts`) is headlined from them, as the Desktop does: `Read a.ts`, `Searched for x · 2 matches in 2 files`, `Edited a.ts +2 −1`, `Created n.txt +2` (a file is named by its own name, never its full path; an edit's counts come from the lines its receipt replaced, leaving out lines both sides share). A conversation saved before facts existed has none and keeps the receipt's first line.

A tool's result is a `⎿` row with the output's first line and, under it, the rest of the output as a collapsible body. A first line of up to 300 characters (`RESULT_SUMMARY_WHOLE_MAX`) is shown whole on the `⎿` row, wrapping if it must, and is not repeated in the body. A longer one is shortened to 120 characters on the row and kept whole as the body's first line, where `Ctrl+O` shows it. A browser action's note (`A navigation to … was blocked before it was sent: …`) used to be printed twice, once cut off and once in full.

A tool that shows the operator something of its own while it runs — the `schedule` tool's confirmation, a question card — first closes the reply the model streamed with the call, as the tool's start would. The kernel hands the loop a tool's start only when its batch settles, and a reply left pending holds every later row out of scrollback: a confirmation taller than the screen was drawn in the redrawable tail with its top cut off, so the job's model, budget and warnings were never on screen while the operator was asked about them.

Model discovery (`agent_models`) shows a compact catalogue: model name and
provider, exact ID, published context size and effort menu. At most five entries
appear, with an explicit remaining count. Empty results and unavailable catalogues
are distinct. Ctrl+O expands the original retained JSON; malformed receipts and
tool failures keep the ordinary output view. This is a TUI projection only and
does not change the model-facing tool result.

## Web searches and fetches

A web search is one row naming what was searched for and one `⎿` line under
it; a page fetch is the same shape with the address:

```text
✓ Web search("OpenClaw agent runtime built on pi-agent-core framework")
⎿ Did 1 search in 9.0s
✓ Web search("OpenClaw embedded runtime")
⎿ Found 3 results in 4.1s
✓ Web fetch(https://docs.openclaw.ai/agent-runtime-architecture)
⎿ Received 7.5KB in 1.2s · ctrl+o output
```

While a call runs, its row under `Working` carries the same `⎿` line as a
status: `Searching: <query>` (`Searching…` while a provider has not yet said
what it is searching for) or `Fetching <host>…`. Once it settles the line says
what it came to: the number of results when the provider or tool reported
one, `Did 1 search` when it did not, the size of a fetched page, and how long
it took. Consecutive searches and fetches sit together without a blank line
between them. The row never wraps: a long query or address is cut at the
terminal's width with an ellipsis. A fetched page or a search's result list
stays behind Ctrl+O. Provider-hosted searches (see [Web search](web-search.md))
are named from the query the provider reports; a provider that opens a page
rather than running a query is shown as a fetch of that page. A failed call
keeps `✗` and its `failed: …` line.

## Tables

A markdown table in a reply is drawn as a box of one-cell rule glyphs
(`┌┬┐ ├┼┤ └┴┘ │ ─`), sized to the terminal: each column gets its widest line
when everything fits; otherwise columns that need no more than an even share
keep their width, and the rest share what remains, each at least as wide as
its longest word (up to 30 cells; a longer word, such as a URL, breaks inside
its cell). A cell too long for its column wraps inside it, and a rule
separates every row. Inline markdown in a cell is drawn — bold, `code`, links —
never shown as `**` or backticks. The header is bold and centred; body cells
follow the separator row's alignment (`:--`, `:-:`, `--:`).

```text
┌───────────────────┬──────────────────────────────────────────────────────┐
│      Katman       │                   Kullanılan yapı                    │
├───────────────────┼──────────────────────────────────────────────────────┤
│ Agent core / loop │ OpenClaw’ın kendi çekirdeği: @openclaw/agent-core —  │
│                   │ agent loop, harness tipleri, mesajlar, compaction    │
├───────────────────┼──────────────────────────────────────────────────────┤
│ Runtime facade    │ src/agents/runtime/, @openclaw/runtime               │
└───────────────────┴──────────────────────────────────────────────────────┘
```

Where the columns cannot hold their longest words, or a row would wrap to more
than four lines, the table is drawn as records instead: a `Header: value` line
per column, wrapped to the full width, with a `─` rule (at most 40 cells)
between records.

```text
Katman: Agent core / loop
Kullanılan yapı: OpenClaw’ın kendi çekirdeği: @openclaw/agent-core — agent
loop, harness tipleri, mesajlar, compaction yardımcıları
────────────────────────────────────────
Katman: Runtime facade
Kullanılan yapı: src/agents/runtime/, @openclaw/runtime
```

Widths are terminal cells as `string-width` measures them, so CJK text and
emoji keep the box straight. A table streaming in is drawn as a table from the
moment its separator row arrives: a lone `| a | b |` line is held back until
the line after it shows whether it is a header, a row is released only once
it is complete, and a line with a pipe after the separator stays a row of the
table rather than falling out below it as a paragraph. A list item or a
blockquote ends the table even when it carries a pipe, as a blank line, a
heading or a fence does: `- a | b` directly under a table is a list item.

## The model's plan

`task_create`, `task_update` and `task_list` leave one block in the transcript
per run of consecutive task calls: a header in words and the checklist as it
stood afterwards. A single operation is named with its subject (`Added task ·
…`, `Started · …`, `Completed · …`, `Failed · …`, `Reopened · …`, `Removed
task · …`, after which the checklist no longer draws the task), repeats of
one operation are counted (`Added 2 tasks`), and a mix or a listing shows where
the plan stands (`Tasks · 1/2 done`). The block keeps growing while nothing else
is written after it in the same turn; the model's text or another tool closes
it, and the next task call opens a new one. No task id, owner or JSON appears
on any surface: the model still receives the ids in its tool results, which the
screen does not show.

The `Tasks · …` header is the CLI transcript group's checklist progress.
The SDK's generic presentation of an individual `task_list` result instead
qualifies its scope as `Current-turn task view · …`. The model-facing result
also reports how many earlier terminal records remain stored outside that
view; see [Task context](task-context.md).

One renderer draws every checklist, the transcript block and `/tasks` alike:
`□` pending, `■` in progress (bold), `✓` completed (dimmed and struck
through), `✗` failed, each followed by exactly one space, with a wrapped subject
hanging under its first letter. This follows the reference terminal that shows
its plan inline in the conversation, once, rather than a second copy above the
input. Above the composer, a single row names the current step and the count
(`■ Write the parser · 1/3 done`) only while that block is out of view — pushed
up by later output, or taller than the space left on a short screen. It leaves
when no step is open.

## Reading the conversation

The `›` mark identifies an operator message and `∴` identifies a Namzu reply.
Both, and every notice and tool row except a web call's (which is cut, see
[Web searches and fetches](#web-searches-and-fetches)), are wrapped by Namzu to
the width beside the gutter, breaking at the
space between words and dropping it, so every row of a paragraph starts in the
same column; a word longer than the row (a URL, a path) continues on the next
row rather than being cut at the edge, and a tab is drawn as four spaces.
Tool results remain grouped beneath their calls, with expandable output and
diffs. Color supports the text and symbols: errors, permissions and task states
retain explicit labels. Raw output remains the original source projection.

Tool output retains every line admitted by the runtime, including long first
lines and diagnostics beyond line 200. For more than six lines, the default
preview shows the first three and last three, with an omission count between
them. This keeps final diagnostics visible without joining nonadjacent lines
silently. Each visible line is shortened to 240 characters, and Ctrl+O is
advertised whenever text is hidden. Ctrl+O opens the retained body; `/raw` also
includes it. Runtime output limits still apply: a retained artifact path
identifies output beyond those limits. Neither action re-executes the tool.

File-discovery calls name both the glob pattern and its directory. A shallow
`*` search is visibly distinct from recursive `**/*`; result and traversal
limits add an explicit incomplete-search notice. See
[Bounded file discovery](../sdk/file-discovery.md).

The writing area is two plain horizontal rules, `─` in graphite, with the input
between them: no side borders, no corners and no title, as in the reference.
The input line starts with a dim `❯ ` (`…` while the composer is paused), and
the placeholder, pasted-text and attachment rows, the effort, model and trigger
rows and the suggestion menus sit between the rules, left-aligned with the
prompt. The only text ever written on a rule is the session mode, `hypermode`,
at the upper rule's right end. The frame is a constant three rows plus the blank
row above it, regardless of the active permission mode — see
[The composer footer](#the-composer-footer) for where the mode itself is drawn.
The frame stays static while working. Opening a permission prompt or text/command
picker hides it while keeping the composer mounted, so drafts and attachments
survive the transition. A text prompt also leaves the composer’s keyboard
listener attached while the composer is hidden; its input guard ignores keys
until the prompt closes, so the first key typed when the writing area returns is
accepted.

The Working label itself has a repeating green fill and pale leading edge,
alongside elapsed time and the turn's output so far, `Working (46s · ↓ 1.1k
tokens · esc to interrupt)`. The count is the provider's reported output
tokens for the turn plus an estimate (characters over four) of the reply and
reasoning streamed since that report, redrawn at most five times a second; it
is absent until the model has written something. On a narrow terminal the
figures after the label are cut with an ellipsis; the label keeps its letters. No extra logo is added to the activity row. This is activity, not percentage
progress. Short screens retain the same animated label. While a question
for the operator is on screen (a permission review, a job's confirmation, a
Continue card, the screen that saves a skill, a text prompt) the row reads `Waiting for you · the question
below` instead, and the time spent there is left out of the elapsed figure
when work resumes. Animation disappears when work ends; no success is
inferred from a stopped turn. Decorative motion is disabled for non-interactive
output, screen readers, `NO_COLOR`, `FORCE_COLOR=0` and `TERM=dumb`.
Animation ticks update only the live activity region, leaving the input and
transcript components alone.
Elapsed time, bounded progress text and task status carry the details. Agent
panels use the same quiet rules and highlight the current selection with the
accent color.

When the full previews would crowd the input area, activity shows the current
tool and total tool count, and the full list returns when space allows. The
plan's live row is always one line: the current step and the completion count,
and on a narrow screen the step alone. These panels also reserve
space before the transcript keeps any older messages in its redrawable tail.

### Scrolling back through the conversation

The conversation stays in the terminal's own scrollback, and the terminal keeps
owning it. To page back through it without leaving the app, press **PgUp** at
the composer. A box opens in the live region (never the alternate screen)
showing the conversation as it stands, with the composer and the footer
unchanged below it. The reply that is still streaming is part of it. Reply
text is shown as written, not rendered as Markdown, so every row is a plain
line.

| Key | Does |
| --- | --- |
| PgUp / PgDn | a page up or down, one row less than the window |
| ↑ / ↓ (or k / j) | one row |
| Home or g | the first row |
| End, G or Esc | back to the latest: the box closes and the session is as it was |

Reaching the last page by scrolling down also returns to the latest by itself;
there is no separate "stay at the bottom" state. PgUp does nothing when the
whole conversation already fits on screen. There is no Ctrl alias: Ctrl+R and
Ctrl+B are the composer's own keys. The mouse wheel is not read, because the
terminal keeps it for scrollback and the app does not switch on mouse
reporting. A permission request, a skill-save screen or a schedule review also
closes the box, so the screen that needs an answer gets the keys.

While the box is open one quiet row above the composer says how to get back,
centered, in the longest form that fits the width: `↓ Back to bottom · esc`,
then `↓ Bottom · esc`, `↓ Bottom`, `↓`. If the reply grows or something new
arrives while the window is scrolled up, the window does not move, and the row
starts with `New activity · ` (`New activity · ↓ Back to bottom · esc`, then
`New activity · ↓ Bottom · esc`, `New · ↓ Bottom`, `↓ Bottom`, `↓`). It is a
flag, not a count, and it clears when the view closes. Rows come from
`transcript-scroll.ts`; `TranscriptScrollView.tsx` draws them; `Composer.tsx`
opens it. Covered by `the-transcript-scrolls-back-and-returns.test.tsx` and
`the-transcript-scrolls-from-the-composer.test.tsx`.

## Commands and settings

Successful reasoning changes receive a short session-scoped confirmation;
resetting the selection names the provider default. Configuration warnings,
instruction-file disclosure, unavailable tools and startup errors remain visible.

A model change requested in conversation shows a compact call row with the
target model. Successful receipt text stays out of the transcript display;
the full pending receipt remains in conversation history. A successful solitary
call ends the turn directly, without a model-generated acknowledgement.
The footer keeps showing the active model while the turn and its persistence
finish. Only a successfully prepared and applied replacement updates the
footer and receives a model-change confirmation. Cancellation or preparation
failure retains the previous session. These conversational changes preserve
history and affect only the current session; see
[Settings and model changes](slash-commands.md#settings-and-model-changes).
Running delegated agents or background jobs prevent replacement, preserving
their active session until that work ends.

The CLI leaves deferred-tool discovery to the kernel. `search_tools` is offered
when the registered roster contains deferred tools; a session whose tools are
all active does not advertise an empty search capability.

The writing area, `/help` and command execution share one catalogue. Commands
with state-dependent availability explain why an action cannot run; execution
checks again before changing state. Opening a menu keeps the draft and its
attachments mounted beneath the overlay.

The common choice row separates the label, current/default markers,
description and unavailable reason. A question from the model marks the
option it recommends with `[recommended]` in the same marker column, from the
option's `recommended` flag rather than its label (see
[Asking the user a question](../sdk/user-questions.md)). It measures terminal display width rather
than JavaScript string length. Narrow screens put the description beneath the
label and reduce the visible page to leave room for navigation. The selected
row can show additional detail without hiding its current marker.

Command, settings, goal, skill, branch and commit menus accept text filtering.
Digits belong to the search query in these menus. Arrow keys navigate and
Enter applies an available selection; non-searchable menus keep their numeric
shortcuts. Esc returns to the parent or cancels, including the earlier-prompt
picker. The first key pressed after a menu appears is accepted; the key that
opened the menu cannot also select its first row. The footer describes the
keys used by the active surface.

Text editors for conversation names and goals keep a single visible input row.
Long values scroll with the cursor, including after terminal resizing, so the
editor title and save/cancel keys remain visible. Omission marks affect only the
display; editing and saving preserve the complete value and Unicode characters.

Permission choices use plain labels: Ask before changes, Auto-approve edits and
Plan (read-only). More options holds automatic tool approval, preapproved-only
execution and the rule report. Both levels identify the effective current
behavior and session scope. Settings use named controls and the same effective
permission value. Internal mode identifiers remain accepted as typed shortcuts.
The approval prompt spells out when a choice allows all tools for the session.
In `prompt`, `accept-edits` and `plan` mode a read-only agent — `explore`, or
an agent file with `readOnly: true` — that runs on the session's own provider
and model starts without a review; see
[Delegated work](delegated-work.md#which-launches-are-asked-about). Every
other launch is reviewed. Agent launch reviews lead with the task, type and built-in tool capabilities,
including the default general-purpose type when omitted. A prompt saying
"only inspect" does not change the displayed tool authority. Role and optional
workflow/phase labels precede the full instructions, which remain pageable
alongside exact JSON. Agent-only reviews use explicit start/do-not-start actions;
the separate session-wide choice still says it allows all tools.

`/status`, `/cost`, `/context` and `/mcp` lead with short factual summaries.
Explicit details show configuration rules, pricing scope, cleanup counters or
tool inventories. A missing measurement is labelled as missing; token totals,
context occupancy and monetary cost are distinct quantities. Cost refers to
the current or latest turn, not an accumulated conversation total.

`/settings` shows the current model, effort and approval mode with links to
their controls and configuration-source diagnostics. It excludes credentials
and does not edit arbitrary configuration keys. Model selection starts with
the current provider. A visible `p change provider` action above the model list
names other detected providers that Namzu can construct from available
credentials. The list states whether selection affects future launches or only
a session using a temporary credential. The old session remains usable if
replacement construction or preference persistence fails.

`/goal` presents objective management and automatic continuation controls,
including the automatic-turn allowance before work starts. `/tasks` reads the
session's own task store, showing every open task and those closed in the
current turn; changing conversations clears the selection without deleting
tasks. `/agents` opens the retained delegated-work
view, while `/agents available` separately reports the configured roster.

The delegated-work view first separates workflows. Independently launched work
in another parent turn appears as a separate workflow, including when names are
reused. Within a turn, explicit workflow labels group phases across tool batches;
unlabelled batches remain separate workflows. Repeated batches in the same
explicit phase do not create new phases. These annotations describe grouping,
not execution dependencies or barriers.

With multiple workflows, the workflow picker opens first. Selecting a workflow
shows its phases, then one phase's agents; Esc returns to workflows and `q` or Ctrl+T
returns to the conversation. Older completed or cancelled work stays available.
Pending admissions show `Queued` until the child session starts. Completed Agent
and `wait_for_task` outputs name the actual `task_id` and terminal status before
the child result, so identifiers inside that result remain clearly separate.

The agent cockpit (Ctrl+T, `/agents`) is the workflow detail view described
under the rail: a header with the workflow's name and
`<done>/<total> agents · <elapsed>`, then `Phases` or one phase's agents, one
list at a time. It opens on the phase whose agents are still working, and on
its first working agent; with nothing live, on the first phase. Unlabelled
delegated work (no `workflow` label) opens straight on its agents, headed by a
neutral count, since it has no phases to choose between. The phase list's own
title is just `Phases`: every `N/M` beside it reads done out of total, so it
carries no cursor position.

Selecting an agent that can take messages views it on the main screen (see
the rail section). Selecting a saved child, or an agent a workflow run
launched, opens a read-only boxed transcript screen instead: the parent
composer and live rows are hidden while their state remains mounted. That view
uses the available terminal height, identifies the task and its live status,
and supports line and page scrolling. File-output tabs are expanded before
pagination, and wrapping uses terminal cell widths for Unicode graphemes. Each
body row stays within its frame, with room for navigation and the cursor. Esc
returns to the agent list (or, when the view was opened from the rail, to that
agent's row on the rail); `q` or Ctrl+T returns to the main conversation and
restores the draft. A child that finishes remains readable in the open view and
can be reopened from `/agents` while retained by the current session.

Messages submitted with Enter while an `Agent` call waits for a child release
that wait so the parent can respond while children continue. Results arrive in
the same turn as task notifications. Tab still queues a future turn; Esc still
interrupts the current turn and its children.

## Plain words for errors and status

The terminal app speaks in the person's terms. `--json`, `namzu exec`, scheduled runs and the ACP host keep the kernel's structured codes unchanged; this applies to what the interactive screen shows.

- **A failed reply** is one sentence naming the provider by product name ("OpenAI did not accept your API key. Check it in /setup, or pick another provider with /model."), plus at most one `OpenAI said: ...` line when the provider's own message adds information. No bracketed catalog ids, no `Provider:` or `Reason:` rows, no raw JSON, status lines, request ids or config-key names. `plain-interruption.ts` builds it.
- **A paused reply** reads "Paused: OpenAI is having problems on its side. Press Enter to try again, or type a new message." (offline and rate-limited have their own wording; a rate limit names the wait as `20s` or `1m 05s`). Enter on an empty composer continues the reply, as it does for a tool that needs a person; `/resume` and `/abandon` still work. No checkpoint id is shown.
- **A quiet stretch while the provider is retried** says why under the Working line: "OpenAI is limiting requests. Retrying in about 20s (try 2 of 5)." It comes from the kernel's retry event and is said once, not as a countdown; it goes away when the provider answers.
- **Failures the app hit itself** (saving a name, forking, archiving) say what could not be done and, for known causes such as a permission or disk error, why; an unknown cause points at `--debug`. `plain-failure.ts` maps them; the raw message is appended only with `NAMZU_DEBUG=1` or `--debug`.
- **A crash** prints "Namzu stopped because of an unexpected problem. Details were saved to ~/.namzu/logs/crash-<time>.log." The stack and the buffered diagnostics go to that file (the newest ten are kept); they print too only with `NAMZU_DEBUG=1` or `--debug`.
- **`/status`** shows the conversation by a short id, the folder with `~`, the sandbox in plain words, and "latest reply" where it used to say "current/latest turn". The version build hash, the executable path and the full conversation id are in `/status details`.
- **Command output in a step** is read from the typed facts the kernel reports with the result (`ToolResult.facts`, see [Tool execution](../sdk/tool-execution.md#what-a-call-did-as-fields)), not from its text, and drawn as a shell command cell (`shell-cell.ts`): a header `● Bash(<command>)` whose dot is green when the command exited 0 and red when it failed (dim and blinking while it runs), with no per-command duration, then the result hung under a dim `⎿`.

  ```text
  ● Bash(for i in $(seq 1 40); do echo satir $i; done)
    ⎿  satir 1
       satir 2
       satir 3
       … +37 lines (ctrl+o to expand)
  ```

  The header keeps the command's real line breaks, at most 2 lines and 160 characters, then a single `…`; Ctrl+O shows the whole command. stdout comes first, then stderr in the error colour; each stream shows its first 3 visual lines (10 when the command failed) and then a dim `… +N lines (ctrl+o to expand)`; a stream with exactly one line to hide shows it instead. A failed command that printed something leads with `Exit code N`; one that printed nothing is only `Exit code N` (a timeout reads `Timed out`, a signal `Stopped before it finished`); a command that printed nothing and succeeded reads `(No output)`; one handed to a background job reads `Running in the background (↓ to manage)`, never the model-facing instructions. Binary output is named with its size. While the command runs the live region shows the same header with `⎿  Running… (12s)`, and, once it reports output, the last 5 lines it reported (the kernel coalesces progress to the latest line, so these are the lines seen, not all of them) above the elapsed time. A stream longer than the kernel's window still has its "… 80 lines not shown" gap counted into the `+N`. Ctrl+O opens everything the host holds, which for a long stream is the kernel's first 80 and last 40 lines. A conversation saved before facts existed keeps the older reading, which strips ANSI, drops the credential note and the exit trailer and reads the status from the text. The retained raw output is untouched. A call the person answered No to reads "You declined this, so it did not run." with their words when they gave any, never the refusal text the model was given; a call to a tool that does not exist reads as one sentence.
- **Key hints appear once per screen.** A picker or prompt draws its hint line inside its own box ("↑↓ select · enter apply · esc back"), and the footer stays quiet while a box is open; it keeps the mode, the folder and the model. The words are the same everywhere: `↑↓ select`, `enter apply`, `esc back` where the key returns to the previous screen, `esc cancel` where it drops what was being done, `esc close` for a viewer. A line wider than its room is one row at every width: each hint has a rank and, where it helps, a short form (`↑↓ or 1–9 select` becomes `↑↓ select`, `esc or ctrl+c exit` becomes `esc exit`, `k enter an API key` becomes `k API key`); the lowest-ranked hint is said short and then dropped (`PgUp/PgDn jump`, `Home/End`, `s provider setup`, `l create a Namzu sign-in` go first), a hint is never cut in the middle, and `↑↓ select`, `enter apply` and the key that leaves are the last to go. Every picker and dialog key line (the provider list and its sub-screens, the sign-in and key screens, the model, resume, copy and edit pickers, the text prompt, the effort slider, the permission prompt, the schedule and save-skill reviews, the agent cockpit, the tool-output viewer, the slash and file menus) is built this way, and the provider list counts that one row in its height budget (a bordered box in the app's padded root has `columns - 6` columns of text, which `boxedHintWidth` in `key-hints.ts` gives; the slash menu's descriptions are held to two lines ending in `…`); the footer's own hint (for example "enter steer · tab queue · esc interrupt" while a reply runs) writes `enter` as `↵` before it drops a hint, and keeps the key that leaves. The folder trust screen has no footer at all: it names the folder and its keys once. `key-hints.ts` holds the vocabulary and the fitting.
- **A list that does not fit says so.** When the provider list is cut to the terminal's height it draws a quiet `↓ 3 more` under the last row it shows and `↑ 2 more` above the first, counted in rows; the lines come out of the height budget, so the box is still no taller than the screen, and the row under the cursor stays in view as it moves.
- **A startup that stopped on a file the person can fix** is the sentence alone, with no dot in front of it and no second block. "Startup stopped / Resolve the error above, then restart Namzu." appears only under an error that does not say what to do itself (a `ConfigLoadError` with `complete` set already ends with "Fix it, then start Namzu again."). The footer under a screen with no composer (this one, the pickers, the trust prompt) names the folder and any active mode but not `shift+tab to cycle`, which is the composer's key.
- **No Node warnings on screen.** `warning-filter.ts` is the first import of `bin.ts`. It drops Node's `ExperimentalWarning: SQLite is an experimental feature and might change at any time` (printed on Node 22 when the session index opens `node:sqlite`) and nothing else: the type and the sentence must both match, so every other warning still prints. `exec`, the scheduler and the desktop host start from the same `bin.ts`.
- **First run with no API key** says what the menu offers: "No API key found for OpenAI, your saved provider. Namzu looked for OPENAI_API_KEY and found none. Choose “Enter an API key” below, or pick another provider." A subscription sign-in row reads "uses a one-time code" or "opens your browser", not the protocol's name.
- **Argument errors** (`namzu --effort turbo`) read as sentences in sentence case ("“turbo” is not a valid value for --effort. Choose one of none, minimal, …"), wrapped at word boundaries to the terminal's width (at most 100 columns), then "Run namzu --help to see what is available." The exit code stays 64. `usage-error.ts` rewrites commander's one-line complaint.
- **After exit** the resume command is printed on a line of its own ("namzu resume <conversation id>"), so a narrow terminal soft-wraps one copyable line; `namzu resume` takes the whole id, not a prefix.
- **A settings file that cannot be read** is one sentence that names the file a person must fix, how they would write it, and where the parser stopped: "namzu.config.json in this project isn't valid JSON (line 3, column 5). Fix it, then start Namzu again." The user-level file reads as `~/.namzu/config.yaml isn't valid YAML (line 1, column 9)`, and the managed file by its path. A file whose top level is a list or a value rather than named settings is named the same way ("namzu.config.json in this project must be a set of named settings, not a list. Fix it, then start Namzu again."). The parser's own wording appears only with `--debug`. A file saved with a leading byte-order mark (Windows editors do this) loads as if the mark were absent, in the CLI, the scheduled-task digest and the desktop app's folder checks.
- **The provider list at narrow widths.** While the source column beside the name would be narrower than 24 columns (a terminal under 63 columns), each source is drawn on its own line under the name, indented to line up with it, and the name is not padded; at 63 columns and wider the source sits beside the name as before. The `← current` mark stays on the name's line when it fits and goes below the source when it does not. The row window counts exactly the lines drawn, in both layouts. The model list's count ("3/3") keeps a column between itself and the title, and a model row whose marks ("(current) (default)") would cut its name short draws them on the line under the name instead.
- **A model list that could not be fetched** is one sentence naming the provider and the next step ("OpenAI rejected the saved API key. Press Esc, then k to enter a new key.", "OpenAI is limiting requests right now. Wait a moment, then open the list again.", "OpenAI is having problems on its side. Try again in a minute.", "Namzu could not reach OpenAI. Check your internet connection, then try again."; for a server on this computer or network, "Namzu could not reach Ollama at localhost:11434. Start it, then try again.", and a list that did not answer in time names the provider: "OpenAI did not answer in time."), then "Showing namzu’s pick for it." The driver's own text follows "Details:" only with `--debug`, with its request ID labelled "Request ID:". A model switch or an effort check that fails says "Could not switch the model." (or the effort sentence) the same way, with the error text behind `--debug`. `modelListingCause` in `agent.ts` sorts the failure (401, 403, 429, 5xx, network, other) and `plainListingFailure` in `model-choices.ts` words it. A failure Namzu hit on its own at startup (the working folder, saved data, plugins, computer use, the browser, building the provider) is one sentence with a next step ("Namzu could not open the folder ~/x. It does not exist. Check the path, then try again.") and the error text behind `--debug`, labelled "Details:". The setup screen words how a credential was found as "Signed in with Codex", "Key from your computer’s settings" or "Saved API key", never the source's identifier. A key the provider rejects on the key-entry screen reads "<Provider> rejected that API key. Check it and try again." the same way.
- **Provider setup (`s`) never prints what a program printed.** The probe's output is read for a version number (`versionFromProbe` skips warnings) and the row says "Installed · version 0.46.0", "Not installed" or "Couldn’t check Codex. Details: --debug"; an install shows "Installing Codex… This can take a minute." and, if it fails, "Couldn’t install Codex. Details: --debug". The raw lines appear only with `--debug`. `setup-text.ts` holds the wording.
- **Folders in a sentence** are written with `~` for home, and when the line is short of room `displayPath` cuts the middle and keeps the first segment and the last folder whole ("~/…/packages/cli"). Every such path, the footer's included, is spelled with the platform's separator (`homePath` and `displayPath` are the one helper: `~\Work\clients\leaf-folder` on Windows, `~/Work/clients/leaf-folder` elsewhere). The folder trust prompt fits its path to the box's real content width (the terminal minus the app's inset, the border and the padding, `boxedContentWidth`), so the path draws one row from 40 columns up, its title and two sentences break evenly with no stray word on a line of its own ("files", "exit" alone), and the two choices share a row only when both fit.
- **A provider that cannot take something the conversation holds** is one sentence built from the event's fields, never from the kernel's text (`capability-notice.ts`): "Ollama can’t use tools, so Namzu will only chat while you use it. Switch to another provider to let Namzu work with files and commands.", "Ollama can’t see images, so it won’t see the picture you attached. Switch to a provider that reads images to include it.", the same for documents, and a "text note in place of a picture a tool returned" variant for tool results. The next step is always "Switch to another provider" (or "a provider that reads images/documents"), because the capability belongs to the provider driver, not the model. A history that was repaired before a reply says what happened in words, with no counts: when steps were left unfinished, "Your last reply was cut off before its steps finished, so Namzu marked them as unfinished. Check any files or commands they touched before asking again."; when only leftover duplicate or unmatched results were removed, "Namzu cleaned up some leftover steps from earlier in this conversation. Nothing you need to do." The counts show only under `--debug`. The provider is named by product name, never its id, and no tool count or label shows. The kernel's own wording follows only under `--debug`, and an exported transcript uses the same sentences (a provider switch reads "Anthropic was too busy, so Namzu used OpenAI for the rest of that reply.", with no ids or reason codes).
- **Setup and picker wording** is plain: the setup intro says the other coding apps are optional and that Namzu can reuse their sign-ins, a missing sign-in reads "Not signed in for Namzu" followed by the login command, "Zen free models · experimental, and Zen may refuse them", "1 found · sign-ins, API keys and local servers". Zen’s free models are experimental and Zen may refuse them, so the Zen rows and notices say that and point at a Zen API key as the next step. Text that can wrap is broken by `wrapBalancedText`, not by the renderer (which starts a continuation with the space it broke at), so no wrapped line starts indented and none is one stray word. Each line wraps inside 40 to 80 columns (`plain-setup-wording-at-narrow-widths.test.tsx`, `plain-provider-list-wording-at-narrow-widths.test.tsx`).
- **Typographic apostrophes**: person-facing text uses ’ ("couldn’t", "Namzu’s"), never inside code, flags, paths or JSON.
- **Launch flags**: `--provider` with a name Namzu does not know says so above the picker; `--model` with a name the provider does not list warns once the session starts; `/model` with a name it cannot find reads "No model called ... is available to you, so the model was not changed." and leaves only that line in the transcript.
- **One glossary** (`person-terms.ts`) names the concepts: "reply" where the kernel says turn, "conversation" for session, "summarising the conversation" for compaction, "on this computer" for host. Sizes are `1.2 MB`, spans `20s`, counts are pluralised.

## The terminal title

The terminal's own title (the tab or window name) says what the conversation is,
as in the reference terminal, whose rule was read from its code. It is set with
OSC 0, which sets the window title and the icon name, ended by BEL:

- **What it says:** a glyph, a space, then the name. The name is the one a person
  gave the conversation with `/rename`; else the title the
  [small model](small-model.md#conversation-titles) wrote; else `Namzu`. It is
  shown on one line (control characters and line breaks are removed) and cut at
  100 characters.
- **The glyph** is `✳` while the interface waits for input and `◐` while a turn
  runs. The reference alternates `◐` and `◑` every 960 ms while it is busy and
  the terminal has focus; Namzu does not track terminal focus, so it shows the
  one busy glyph and writes the title only when the text changes.
- **When it is written:** when the interface opens, when the name or the
  generated title changes (`/rename`, the first message's title, `/resume`, a new
  conversation), and when a turn starts or ends.
- **On exit** it is reset with an empty OSC 0 (`ESC ] 0 ; BEL`), including when
  the process exits abnormally, so the shell's own title comes back.
- **Off:** `NAMZU_DISABLE_TERMINAL_TITLE=1` (the reference's
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`). Nothing is written to a stream that is
  not a terminal.

## Terminal boundaries

A command entered with `!` runs in the operator's shell. Its captured output reaches the next model request as an observation in user-role context; text printed by that command has no system-prompt authority. The CLI still shows the result in the transcript.

The interface uses the normal terminal buffer so completed output remains in
native scrollback. Its transcript owner remains mounted through startup and
provider pickers, with the live rows hidden while a picker owns the screen.
Only the current work is redrawn, and the redrawn region is always at least
one row shorter than the terminal: a reply, a table or a picker taller than
that keeps its newest rows on screen and gives way at the top, and the whole
reply reaches scrollback when it finishes. A region as tall as the terminal
sends the renderer down a path that clears the screen and replays the session
on every frame, and that loses the last settled line of a long reply when the
region shrinks again (`packages/cli/src/tui/ViewportBound.tsx`). Changing terminal width
keeps the selected agent and the input draft, while model/path text yields to
the keys needed to leave a prompt. The palette targets dark backgrounds; the
application does not paint a full-screen background or depend on color alone.

When the terminal contracts, native reflow can push old live rows into
scrollback before the renderer can erase them. When it expands, completed rows
already printed into scrollback keep their old line breaks. Namzu clears and
reconstructs its normal-buffer transcript on either width change, preserving
conversation messages, the draft and the selected agent. This costs one history
replay per width change; ordinary streaming and animation frames remain
incremental. A height reduction also rebuilds the transcript. An open retained
tool-output viewer stays open through a resize.

On Windows, a program run as the desktop's embedded interpreter on a pseudo-console
is not seen to receive Node's console-layout notification, the only thing that makes
`process.stdout` emit `resize`. Without it Ink keeps the width it started with and every
line it writes wraps in a narrower pane. On that platform, on a terminal, the TUI
therefore asks the console for its size every 250 ms through Node's own refresh
(`output-size-watch.ts`), which raises `resize` itself when the answer changed; nowhere
else is anything polled. The footer shortens a Windows path at a backslash as it does
a POSIX path at a slash, and writes `~` for the home folder from `USERPROFILE` when
`HOME` is not set. `resize-pty.test.ts` resizes the real CLI in a real pseudo-terminal
and checks the box, the corners and the footer at each width; the desktop's
`narrow-cli-tab.test.mjs` does the same in a Namzu CLI tab as the window narrows and
splits.

Screen regressions drive the production Ink renderer through a terminal
emulator. They check wrapped input, short viewports, retained drafts, normal
scrollback and the amount of output emitted during streaming. These checks use
controlled session events and require no model calls.

When a turn stops for budget, iteration, policy or validation reasons, a short
reason notice stays beside any retained partial output. Normal completion and
operator cancellation do not add a redundant stop notice. The composer remains
usable for a follow-up; a token allowance refusal does not claim every reserved
token was spent.

When startup cannot load its state or construct a session, a `Startup stopped`
notice replaces the writing area. The detailed error remains in scrollback;
Esc or one Ctrl+C closes the application so the operator can repair the named
file and restart. A startup refusal does not create an unscoped session or
silently replace an installation identity.

## Paste and response boundaries

The composer enables terminal bracketed paste while it owns input. A paste split
across terminal input chunks is assembled before editing the draft; pasted
newlines do not submit it. Windows CRLF and CR line endings become LF. Large or
multiline text has a `Pasted text #N · N chars` chip; the count uses Unicode code
points, including emoji as one code point. Short single-line pastes insert at
the cursor. Terminals without bracketed-paste support retain chunk-based fallback
handling, which cannot reconstruct a paste boundary the terminal does not send.

Separate provider message IDs create separate assistant transcript entries,
including completion follow-ups inside one parent turn. Pending text is flushed
at that boundary so the last status sentence cannot merge with the next answer.
Saved public item boundaries are also restored when resuming or forking earlier
history, provided the parts still agree with its current selected content.
Empty assistant text produces no transcript row. Equal nonempty public items
remain distinct; this projection does not deduplicate what the model said or
alter the durable messages sent on continuation. The one row that is
deduplicated is a system notice identical to the row directly before it (same
text and mark, no body): the second copy is dropped where notices are written,
since the same sentence twice reads as two events.


Typing that arrives in one read — keystrokes queued behind a busy screen, with
no bracketed-paste markers around them — is typed text, not a paste, however
long: it goes into the draft at the cursor. It used to become a chip once it
passed 80 characters, and the chip was joined back to what had been typed
before it with a paragraph break, which split the word it landed in (`subag` /
`ents`) in the message the model received. A bracketed paste over 80
characters, and any unbracketed chunk that contains a newline, is still a chip.

A row keeps its column and its wrap when it settles into scrollback. Settled
rows used to lose the one column of padding live rows have, so a finished
screen mixed rows starting at column 0 and column 1, and a long settled row
wrapped two columns wider than it had while live. Nothing written after a reply that is
still streaming settles before that reply does: a row written meanwhile (an
agent's launch receipt, say) used to settle first, and when the reply then
finished it landed below rows already printed, so one row was printed twice and
the reply's own sentence never was. A reply that is still streaming is also
drawn where it stands in the conversation, not below every finished row, so a
row written meanwhile appears under it and neither moves when the reply
finishes. It used to be drawn last, which put such a row above the text that
came before it until the turn ended, and then swapped the two.

The agent browser owns its viewport rather than sharing it with an inactive
composer. Its navigation stays at the bottom and list capacity grows with the
terminal height. Returning to the main conversation restores its draft.

## File write presentation

A write approval shows the proposed complete body, labelled as a possible
replacement rather than a confirmed new-file diff. Its line count excludes a
final line terminator while preserving real blank lines. On completion the
SDK receipt supplies Created, Updated, Unchanged or Wrote (unknown prior state),
UTF-8 byte count and, when available, the changed-region preview. The diff label
is independent of the path. Final-newline-only changes are explicitly named.
This display change does not grant permission to overwrite a file.

Refused or truncated tool arguments can still produce a call row. The CLI
checks the tool's presentation shape before rendering it in the terminal or
ACP: an invalid call view uses the tool name, and an invalid result view retains
the original result or error text. Unreadable arguments are not serialized as a
replacement label. Presentation cannot interrupt the model's repair attempt
or turn settlement; tool validation and permissions still decide execution.

A command approval shows the command as it would be typed: quotes and
backslashes verbatim, never JSON-escaped. Each line of a multi-line command is
its own row, the first after `$ ` and every later one indented under it, so a
line of the command cannot pass for a field of the prompt or another call. A
carriage return, and every other control or invisible character, is spelled
out as `\u{....}`; `d` shows the exact input.

## Task continuity in the CLI prompt

The CLI identity describes Namzu as an agent kernel with a TypeScript SDK and
the CLI as one interface. Completed prior-turn tool actions remain usable
evidence; the identity does not require a fresh action just to report earlier
work. It still forbids invented actions and distinguishes current execution
from history. An unavailable capability blocks dependent work, not unrelated
parts that can still be completed. Shared coding guidance uses proportional
verification and defers concurrency guarantees to runtime metadata.


Ctrl+O does not reprint an old result into scrollback. When an expansion cannot
fit the live region, a bounded output viewer owns that region instead. A body
that has settled into history keeps its Ctrl+O hint, because a settled row is
never repainted, so the key keeps reaching it: the first press opens the live
bodies in place, and the next one, while a settled body sits above them, folds
them again and opens the viewer on the newest settled body. With nothing
settled to open, the second press only folds them. It
paginates physical rows, preserves retained text, and supports left/right output
navigation. Closing it restores the composer draft. Incoming approvals close the
viewer so permission input stays reachable. This changes only presentation, not
model history or tool execution. Existing static scrollback is not erased.

Screen regressions use the existing `@xterm/headless` emulator with production
Ink rendering to exercise repeated opening/closing, pagination and scrollback
counts. It interprets emitted terminal control sequences; it does not replace
Ink's component layout or require a browser terminal in the CLI.

## Upgrade activity

`namzu upgrade` animates a green fill through the existing wordmark while npm
installs the selected version. This is an activity loop, not a percentage.
The wordmark remains fully green only after the installed version is read back
and matches the requested version. Failures clear the animation and show npm
diagnostics (the last 16,384 characters) followed by the error.

The animation uses stderr only in an interactive text terminal. `--check`,
quiet mode, structured output, `NO_COLOR`, dumb terminals, and redirected stderr
keep static output. Terminals below 28 columns use the compact signature; below
12 columns the animation is disabled. The renderer releases its timer and exit
listener when the operation finishes, and clears its display on process exit.
