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

**No footer under a dialog.** The footer belongs to the message box. While a
permission request, a question, a plan or skill review, a picker, a text prompt or
a full-screen choice (resume, edit, provider setup) is on screen, no footer is
drawn: the box carries its own key line, so nothing under it says half of the
footer (the model alone, or a mode without its cycle hint). The one exception is
a transient notice that needs the row, such as `Press Ctrl-C again to exit`, which
brings the footer back for as long as it lasts. The footer returns with the
message box.

A [custom status line](status-line.md), when `statusLine` is configured, is drawn on the
rows above this line, and the quiet `shift+tab to cycle` reminder then stays off.

One line sits directly below the composer's lower rule, with no blank row between
them. Its items are joined by a dim ` · `, left to right:

```text
⏵⏵ bypass permissions on · PR #607 · 3 bg · esc to interrupt · ← 1 agent · ↓ to manage   model
```

- **The mode**, as `<mark> <words> on` in the mode's color, then a dim
  `(shift+tab to cycle)` when Shift+Tab actually cycles it here and no
  background shell is running (a running task takes the
  reminder off the row). `bypass` reads `⏵⏵ bypass permissions on` in the error
  color, `auto` reads `⏵⏵ auto mode on` in the warn color, `accept-edits` reads `⏵⏵ accept edits on` in the user accent, `plan`
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
- **Background shells**, a cyan pill `N bg` (commands and monitors together). It replaces the
  separate `N shells running` line that used to sit under the footer, and it
  hides with the composer surface (a permission or child view owning the
  screen).
- **The reasoning effort**, when the operator has set one, as `effort <level>`
  (Namzu's own item).
- **`esc to interrupt`**, dim, while a turn runs (omitted when the right side
  already carries a hint that names Esc; no footer is drawn while a dialog or
  picker owns the keyboard). The Working row does not repeat it; it lives here only.
- **The notice slot.** The right end of the row shows one passing notice at a
  time, behind a hint and ahead of the goal, a standing item and the model. Notices
  queue by priority (`immediate`, `high`, `medium`, `low`; equal priorities go
  in arrival order) and each stays 8 s unless it names its own time. An
  `immediate` notice shows at once and the notice it covers returns after it
  (an `immediate` one only if it asks to); anything else waits for the one that
  is up, so a `medium` notice that stays is never displaced by a `high` one.
  The same key never queues twice: a newer reading of a showing notice
  replaces it and restarts its time. Notices are dim unless they name a tone,
  and a dialog's own key line outranks them. The notices today:
  - `Esc again to clear` (immediate, 1 s): the first Esc on a typed draft
    shows it; the second Esc inside 800 ms clears the draft. One Esc no
    longer clears it, and an Esc after the window arms again. A running turn
    keeps Esc for interrupting. The cleared text is added to the prompt history
    (blank text is not), so Up and Ctrl+R bring it back.
  - `No background agents running` (immediate, 2 s) and
    `Press ctrl+x ctrl+k again to stop background agents` (immediate, 3 s)
    from the stop-all chord.
  - **The context meter**, dim `12% until auto-compact` (medium, stays while
    true), once the context is within 20,000 tokens of the point where older
    history is summarised. The percentage counts down to that point, not to the
    end of the window, and the point is the kernel's own trigger
    (`resolveTriggerThreshold`: the window less up to 20,000 tokens for the
    reply less 13,000, so 167,000 tokens of a 200,000-token window). With
    auto-compact off it reads `Context low (N% remaining) · Run /compact to
    compact & continue` in red, counted against the whole window (no CLI
    strategy turns it off today). It is hidden from the moment a compaction
    finishes until the next turn starts, and it is not in the left items, so
    `esc to interrupt` and the rest stay while it shows.
- **The update line.** The [background updater](updates.md) leaves at most one
  standing line at the right end, yielding to a hint, a notice and the goal and
  sitting ahead of the model. While an automatic install runs it is dim,
  `Updating to 41.3.0…`; once it is installed it is green with a check,
  `✓ Updated to 41.3.0 · restart to use it`. When Namzu may not or could not do it
  itself it is yellow with the exact command bold: `Update available! Run: namzu
  upgrade`, or `Couldn't update Namzu on its own. Run: <command>` after a failed
  attempt (once per version; later starts say `Update available!` with the same
  command). Nothing is shown while it only checks, and a source checkout,
  `npx` and the Desktop copy show nothing at all.
- **The exit reminder.** The first Ctrl+C with nothing to interrupt, or Ctrl+D
  on an empty composer, puts a dim `Press Ctrl-C again to exit` (or `Ctrl-D`)
  in the right-hand slot for 800 ms; the same key again inside that window
  exits. Nothing is written to the transcript, so nothing stays in scrollback.
  Ctrl+D with anything typed remains delete-forward.
- **`← N agent(s)`**, dim, when `←` from an empty composer would open the agents
  (never where `←` opens the workspaces screen instead)
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
  tasks`); Enter opens the same
  `Background` dialog `/tasks` opens. `↓` again moves into the agents rail (`main`,
  then the agents, then the workflows) and `↑` from its first row moves back
  to the pill. With no shells the first `↓` lands on the rail, and with no
  rows either it opens the agents cockpit, as before. Esc or any other key
  hands the keyboard back to the composer.
- **`←`** from an empty composer opens the [workspaces screen](workspaces.md#opening-it-from-a-conversation)
  where there is one (a POSIX terminal with a pseudo-terminal component), and
  the agents cockpit (`/agent`) everywhere else. With anything typed, pasted or
  attached, or with Shift/Ctrl/Alt held, it is cursor movement as always. A
  press right after the draft was emptied by editing only shows `Press ← again
  to open workspaces`; presses less than 150 ms apart (key repeat) or within a
  second of one that opened or armed are ignored. With the workspaces screen
  available the cockpit is reached with `↓` or Enter on an agent row in `/tasks`, and the footer does
  not offer `← N agents`.

The footer is always exactly one row. On narrow screens it drops, in order: the
model on the right, `↓ to manage`, `← N agents`, `esc to interrupt`, the cycle
reminder, the effort label, the shell pill, the pull request item, the quiet
reminder, and only then does the mode truncate. Whole items go, never half of
one.
Where no composer is on screen (a picker, the trust prompt, a stopped start) the
footer leaves out the cycle reminder, since Shift+Tab is the composer's key; the
active mode stays. This single line replaces the permission-mode row that used
to appear inside the writing area, the separate status line below it, and the
shells line under that. Pending input and transient notices stay inside the
composer's rules, above the input.

Deliberate differences: the model identity (`Auto · fast ·
model` while Auto routing is on) stays on the right while it fits; `← N agents`
counts this session's running agents and workflows and `←` opens them, not other
background sessions that wait for the person, and `←` never sends the session
itself to the background;
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
messages`, the first three times it would appear (the count is kept in
`~/.namzu/hint-counts.json` as `queuedMessagesHint`, so it carries over
between launches; each appearance counts once, and the words are decided
before the frame is drawn, so the usual placeholder never flashes first), then
the usual placeholder returns. Enter on an empty box loads the chosen queued
message for editing; it never sends the queue. On the very first prompt of a
conversation the placeholder is a rotating example, `Try "fix lint errors"`,
and, in a git repository, ones that name a frequently modified source file
(`Try "refactor src/app.ts"`). Alt+Up still restores the newest one at once. A held queue says why
under its rows: after a failed reply `Paused after the failed reply · send a
message to run them`; after Esc, a new Enter message runs before the queue.
`ctrl+x ctrl+s` is a two-key chord (any key in between drops it) that does what
Esc does with a pending steer, interrupting the reply so the steer starts the
next one, and also releases a queue that Esc had held.

A running background shell shows as the footer's shell pill (above). The `/tasks` child view is the `Background` dialog (no job ids on screen; rows read `● <command>  running|done|error|stopped`, details are `Shell details`); a finished job also leaves a `● Background command "…" finished (exit code N)` row in the transcript. It keeps the input draft mounted, lets the
operator inspect bounded, escaped shell output, and stops a selected running
job on `x`. A new question from a tool closes the shell view so the question
is visible and answerable.

[Hypermode](slash-commands.md#hypermode), while on for the session, is named
once at the right end of the composer's upper rule in violet. The rule rests in
plain graphite. The footer does not repeat it. Turning the mode on sends one
short lavender glow from the visible rule's center toward both ends, then the rule becomes still again. Repeating
the selection does not replay it. Motion is skipped in non-interactive terminals,
for screen readers, and when colour is refused (`NO_COLOR`, `FORCE_COLOR=0`,
`TERM=dumb`); the label remains readable without colour. A frame too narrow for the
complete mode name omits the label rather than clipping it.

`NO_COLOR` (set and not empty) with no `FORCE_COLOR` of your own is turned into `FORCE_COLOR=0` before the
renderer's colour library loads, so the whole terminal UI draws without colour; before this only the
background tint of your message honoured it (`packages/cli/src/no-color-env.ts`). A `FORCE_COLOR` you set
yourself stays as you set it.

### Esc

Esc means one thing at a time, and the thing is chosen by what the screen is doing:

| Where | One Esc | A second Esc |
|---|---|---|
| A reply is running | interrupts it | nothing more to stop |
| Idle, a draft typed | shows `Esc again to clear` for a second; the draft stays | within 800 ms clears the draft and adds it to the prompt history |
| Idle, empty box, at least one message sent | arms, shows nothing | within 800 ms opens the [rewind dialog](file-checkpoints.md#rewind) |
| The detailed transcript, the rewind dialog, a picker or a dialog | closes that screen, or goes back one step | closes the next one |

The two 800 ms windows are separate and never count toward each other. Any other key between two presses (typing, deleting, moving the cursor) ends the window, so the next Esc is a first press again; a draft cleared by the second Esc leaves the next Esc as the first press of the rewind window; deleting the draft down to nothing does the same. A press that arrives after the window is a first press. In the detailed transcript Esc closes the screen and does nothing else, so it neither clears the draft underneath nor interrupts a reply that is still running.

### Composer triggers

A [composer trigger](composer-triggers.md) — `hypermode`, "bunu skill olarak
kaydet" — gets one row inside the composer's rules, above the input, where the
`Effort:`/`Model:` previews go:
`Hypermode · this reply: offers workflows, effort unchanged · alt+w drop`.
The armed words in the draft are bold and underlined in sky (ANSI 117), the
trigger's own colour: violet belongs to the session mode, which lasts, and a
trigger lasts one message. The highlight is cut from the draft before unsafe
characters are escaped for the terminal, so it stays on the right cells. The
row is sentence case and has no glyph; the state is a word or mark (`?`,
`(off)`, `unavailable …`), so a terminal without colour loses nothing. The row is one row at every width and
shortens by steps (full copy from 84 terminal columns, a short form from 64,
label and key from 44, the label alone below). The border and the footer are
unchanged by a trigger: a one-turn max-effort pin shows in the row and in the
transcript line under the message (a hypermode keyword says `Hypermode is on
for this reply: Namzu may use workflows.` and pins nothing),
and the footer keeps the session's own effort. The queued-message heading names
armed triggers on taller terminals; a compact terminal prioritizes the next
message's text.

Every mark on this line and in the plan is a text-presentation character one
cell wide by Unicode's own width data: `⏵` (U+23F5) for modes that approve on
their own, `‖` (U+2016) for modes that hold. `⏸` (U+23F8) is an emoji code point; Windows Terminal draws it
as a blue two-cell tile, so this line does not use it.

Shift+Tab changes the mode and the footer is its whole reply: no transcript line is written, however many times it is
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
rail, the agent cockpit, a child transcript, or the detailed transcript, each
in the same relative order they already had among themselves. The footer's
own row is fixed relative to the frame above it, never to whichever of those
panels follows, so it always reads immediately under the input regardless of
how much the rail or a full-screen surface below it is showing.
The agent cockpit's per-workflow header names its workflow by the label every
one of its agents shares; when they carry none, or carry more than one, it
shows a neutral count (`2 agents · 1 running`) rather than a generic name that
described none of them in particular. So does each row of the cockpit's own
workflow picker (the cockpit with two or more groups live or retained at once): a
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
cells, shared by agent and workflow rows; every agent row has it, so a row reads
the same whether it is alone or among others. The description is always the
sentence the agent was launched with, and its **live label** (cut to 24 cells,
left out below 64 columns) sits in the right-hand block before the clock:
every 30 seconds, while a background agent runs and has done something new
since the last time (and at least three messages' worth), it is asked once, on
its own model with no tools, to say in three to five words what it is doing
now, in the language of its task. Only one plain line of at most 100
characters is accepted; anything else is dropped and the old label stays. The
label goes when the agent ends, and agents inside a `workflow` run keep their
own labels. The cost of that request is not charged to the run's token
ledger (see the open questions). Rows follow launch order. Workflow and phase labels, model and
tool counts are not on the rail; the cockpit (`←` or `↓` from an empty composer, or Enter on an agent row in `/tasks`) and the
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
`enter to view · x to stop` (`x to clear` once it has finished), plus
`ctrl+x ctrl+k to stop all agents` when more than one agent runs and the line
is at least 90 columns wide; `main` reads `↑/↓ to select · enter to view`, and
the row already on screen reads `↑/↓ to select`. Esc is not advertised but
still hands the keyboard back to the composer, as does any other key. ↑/↓
moves between `main`, the agents and the workflows (a `❯` marks the row), Enter
on an agent views it (see below) and on `main` goes back to the conversation,
`x` stops a running agent (the parent turn and the other agents keep going) or,
on a finished one, clears its row, and `ctrl+x` then `ctrl+k` stops every
running background agent. The composer stays on screen, dim, while the rail has the keys. `←` or `↓` from an empty composer opens the cockpit. While an
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

Keys while an agent is viewed: **Esc** on a running agent
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
cockpit.

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
the key line is `enter to view · x to stop` (`x to clear` once it has
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
agents · 112.0k tokens` (dim), `✗ … failed · … · 3 agents …` (red) or `■ …
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
● Agent "Choose first colour" finished · 1m 4s (ctrl+o to expand)
● Agent "Choose second colour" failed: Provider refused the request
✻ Worked for 38s · done 3:45 PM · 3 agents · 27.0k tokens
```

Delegated work leaves these rows, each written once and never redrawn; the
live state belongs to the rail.

- **A launch receipt** per batch: the agents one model response launched
  together, each by its description under one line (`N background agents
  launched` when they all run in the background, `Launched N agents` while a
  batch the turn waits on runs, `N agents finished` once it has ended, and `N agents: 2 finished, 1 failed` when some of them failed or were stopped, so the line never says `finished` over one that did not). A
  single agent is named inline. Agents the
  model gave a `workflow` label are one workflow and get one `● Workflow <name>`
  line instead (see the rail section), once per workflow. The receipt waits until
  the batch is whole, so agents launched in the same response share one
  receipt, and it is always written before any of its agents' completions.
  It is drawn below the reply that launched it even while that reply is still
  open: a reviewed batch's events reach the terminal only when the batch
  finishes, so the reply stays open for the whole of a foreground agent's run.
  An agent resumed by a later message gets no second receipt.
- **One row per agent that reports on its own.** The line that says it is over:
  `● Agent "<description>" finished · 1m 4s (ctrl+o to expand)` (green; the hint
  follows the time in parentheses, after a space, and the answer behind Ctrl+O is
  the child's text, shown as text: terminal controls in it are displayed, never
  obeyed), `failed: <reason>` (the glyph is red and the sentence is plain text, with no
  duration; the sentence is the error's own text on one line, and
  `Unknown error` stands when nothing says why) or `was stopped by user · 1s`, `was stopped by Namzu ·
  1s` (the conversation's own agent stopped it with `cancel_agent`), or plain
  `was stopped · 1s` when nobody recorded who (warning). Ctrl+O opens the detailed
  transcript, where the answer is shown whole. The result is not repeated in
  the line and it carries no token count; an agent resumed by a later message
  writes the row again when it ends again. Only an agent that runs on its own
  writes it: a background launch, one whose wait was released (the operator wrote
  while the parent waited) and one a later message resumed.
- **A live group while the turn waits on a batch.** `Running 3 agents…`, then per
  agent `description · 4 tool uses · 12.1k tokens` over `⎿ <last tool>` (or
  `Initializing…`, `Done`), above the composer. The batch's receipt, `3 agents
  finished`, is written when the last member ends. An all-background batch has no
  live group: its receipt is written at launch and the rail shows the agents.
- **One agent waited on shows its last three calls.** When the group holds exactly
  one agent (across all batches), the `⎿ <last tool>` row gives way to its last
  three calls, one dim row each, newest at the bottom: the tool in plain words and
  what it acts on (`Read src/a.ts`, `Run npm test`, `Search parse`), with a mark,
  `◌` for the call that is running, `✓` for one that ended and `✗` for one that
  failed. When there were more, one dim line above them says how many earlier
  calls are not shown and how to open them (`… 5 earlier calls not shown (↓ to
  manage)`). Before its first call the line stays `Initializing…`. The rows change
  only when a call starts or ends; nothing cycles and no timer runs.

  ```text
  Running 1 agent…
    └ Audit the project · 5 tool uses · 525 tokens
        … 2 earlier calls not shown (↓ to manage)
        ✓ Run sleep 2; ls
        ✓ Read b.txt
        ◌ Run sleep 2; exit 3
  ```

  **When it does not apply.** Several agents waiting together (in one batch or in
  two) keep one line each with the latest activity, as above: three calls per
  agent would make the group taller than the live region can spare. The block is
  also left out when the window is short: it is drawn only when the terminal has at
  least 11 rows beyond the live furniture (the 10 fixed rows, the plan, the
  running calls and a queued message); 11 is the window's six safety rows, the
  three rows the block adds and two rows of conversation. At 120x40 that is nearly
  always. At 80x24 a waited-on agent already puts the running `Agent` call and the
  agent rail in the furniture, so the group keeps its one-line form there. The
  block's extra rows are counted in the live window, so it never pushes the message
  box around. It holds in both screens (the default screen's live region, and
  fullscreen's redrawn view). `tui.agentCalls: false` in your own config turns it,
  the finished block below and the calls in the detail off.
- **A batch of waited-on agents that all finished ends as one block**, in place of
  the receipt and two rows per agent: how many finished with the totals, then one
  line per agent (its name, what it was asked, its counts), the detail behind
  Ctrl+O (a click in fullscreen):

  ```text
  ● 3 agents finished · 12 tool uses · 1.6k tokens · 2s
    ├ general-purpose (Check a) · 4 tool uses · 525 tokens · 2s
    ├ general-purpose (Check b) · 4 tool uses · 525 tokens · 2s
    └ general-purpose (Check c) · 4 tool uses · 525 tokens · 2s (ctrl+o to expand)
  ```

  Members that finish early wait for the rest, so the block is written once, when
  nothing in the batch is running. An agent that failed or was stopped is never in
  the block or its count: it keeps its own row in its own colour, and the receipt
  (`4 agents: 3 finished, 1 failed` over the names) stays above the block of the others. One
  finished agent alone keeps its `Done` row. A reopened conversation and
  `namzu watch` build the same rows with the same code as the live run.
- **A waited-on agent writes the tool's own result instead.** An agent the
  parent waited on hands its result back inline, so there is no notification:
  the row is `● <type> (<description>)` over
  `⎿ Done (3 tool uses · 12.1k tokens · 8s)`. A failed or stopped one keeps the
  closing line above. Ctrl+O opens the row (a click in fullscreen): `Calls`, one
  line per call with its outcome mark (`✓`, `✗`; `◌` for one still running when the
  agent was stopped), `N earlier calls are not retained.` when the agent made more
  than its transcript keeps (120 rows), then `Answer` and the agent's answer. The
  calls come from the agent's retained transcript, which a reopened conversation
  rebuilds from the child's saved log, so they are there after a restart as long as
  that log is; when it is not, the row says `This agent made N calls; the list is
  not available any more.` instead of an empty list. A background agent's finished
  row and the notices for agents that finish later are unchanged: their detail is
  the answer.
- **A message a running agent sent.** An agent can say something to the
  conversation while it works, with its own `send_message` tool (`to: "main"`);
  it is drawn as the same collapsed `› Message from @<type> (ctrl+o to expand)`
  row, and the model gets the text, framed as the agent's own words, with its
  next turn (an idle conversation wakes for it). It does not interrupt a wait
  the running turn is in.
- **A waiting line** when a turn ends over background agents that are still
  running: `✻ Waiting for 2 background agents to finish` (`and 1 dynamic
  workflow` when one is running), dim, above the composer, which is free. The
  closing line below is written when the last one ends, with the wait counted.
- **A closing line** when a turn that launched agents settles: how long the
  turn took and how many agents it launched (phases are never counted here),
  what they spent when any reported it, and how many failed
  when one did. A turn that delegated nothing closes with its time alone,
  `✻ Worked for 46s · done 3:45 PM`, when it finished normally and took three seconds or more
  (time spent waiting for a permission or a question to be answered is left
  out);
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
old rail. `⏺`, `✔` and `✳`
are emoji code points Windows Terminal can draw as two-cell tiles, and are not
used.

## Compact tool activity

Consecutive calls that only look fold into one counted line instead of a row each: built-in file reads, searches and file discovery, directory listings, shell commands whose every piece is a known search, read or list command (`rg`, `grep`, `find`, `cat`, `head`, `ls` and the like, with no redirect other than `2>&1` or to `/dev/null`, no substitution and no background `&`), and every call to a connector (MCP) server. The line counts what happened, `Searched for 2 patterns, read 3 files, listed 1 directory`, dim, with the numbers bold and `(ctrl+o to expand)` after it; connector calls read `Called docs, slack 4 times` (the server names, once each, and the number of calls when more than one). A file read twice counts once; a glob counts as a search. While the run is open the line is in the present tense with a blinking dot and a closing ellipsis and the same `(ctrl+o to expand)` after it, `Reading 1 file…`, and a dim `⎿` row under it names the latest target (a path from the working folder, `"pattern"` for a search, `$ command` for a shell look, `"query"` for a connector); that target is the newest call the line has started: it shows as that call starts, stays until another one starts, and nothing about time changes it; the counts only go up (a call to a tool that does not exist, which never ran, is the one thing taken back out). In the [fullscreen view](#fullscreen-mode) an open line carries the same `(ctrl+o to expand)` (`(click to expand)` where the pointer is reported) and the same target row. Text from the model (empty text does not end it), any other call (an edit, a write, a command that does something), a notice, the person's message or the end of the turn settles the line into the past tense, and the next look starts a new one. The [detailed transcript](#the-detailed-transcript-ctrlo) (`Ctrl+O`) shows each call of the line, open or settled, as its headline and retained output in order, and a resumed conversation folds its saved calls the same way. A shell command that is not look-only joins the line when it ends well, as `ran 3 commands` (`running 3 commands` while the line is open, after the listings and before the connectors); a command that is a version-control action is counted by what it did instead, in a fixed order before `ran`: `made 2 commits`, `amended 1 commit`, `ran 1 push`, `created 1 branch`, `switched branches 2 times`, `ran 1 merge`, `ran 1 rebase`, `opened 1 pull request`, `merged 1 pull request` (`making`, `amending`, `pushing`, `creating`, `switching`, `merging`, `rebasing`, `opening` while the line is open; once over, a push, a merge and a rebase say what was run and not what changed, because the line cannot see a result and a push or a merge that found nothing to do ends well too), so a commit, a push and an opened pull request read `Made 1 commit, ran 1 push, opened 1 pull request` and not `ran 3 commands`. Only a command whose word is `git` or `gh` counts, read from the unquoted text after environment assignments and global options (`-C <dir>`, `-c <key=value>`, `--no-pager`); text inside quotes never counts (a commit message that says "push" is a commit, an `echo` of a git command is nothing), and a command line joined with `;`, `||`, a pipe or a line break is not read at all, because a successful end does not say every piece succeeded (`&&` chains are). A name that is not known (an alias such as `git ci`, `sudo git push`, `git checkout main`, which may be a branch or a file, `--abort`, `gh pr create --web`, `gh pr merge --auto`) stays a plain command: when in doubt the line counts less. Reads such as `status`, `log`, `diff` and `show` are never actions. One command line that holds several actions counts each once (`git add -A && git commit -m x && git push` is one commit and one push), and it leaves the `ran` count only when everything in it was an action or a step that only reads or stages (`git add`, `git fetch`, `git status`, `git branch -a`, a dry run, `cd`, `echo`); a step the line cannot name (`git stash`, `git tag`, `git pull`, `git reset`, `git branch -D`, `gh pr close`) keeps the whole command in the `ran` count as well, so `git stash && git switch main` reads `switched branches 1 time, ran 1 command`; a line that also ran something else (`pnpm test && git commit`) is counted in both. The commands listed under the line and the detail behind Ctrl+O are unchanged. The wording is worked out from the stored command lines each time, so the live line, a resumed conversation and a watched one read the same. The commands are listed under the line, oldest first, one per row as `$ command` (its first line, `…` when more follows), each cut to the width with `…` so it is one row, the last five of them, with a dim `2 earlier commands not listed` above when there are more; a live look's latest target comes after them. The rows are at most six however many commands ran, and the live window counts them (`live-window.ts`). A command that did not end well never folds, and the line before it settles first so the order on screen is the order of events: one that exited non-zero (an exit that is the command's own answer, such as `grep` finding nothing, is a success), timed out or was stopped by a signal (all three read as failed), one that came back as an error (blocked, refused, an unusable input), one the person declined or declined on the tool's own screen, and one that moved to a background job (`facts.background`, which the shell cell carries as `background`; it has not finished). Only the `bash` tool folds. A tool-result screen that refuses a result makes the call an error, so it keeps its own row; a screen that rewrites a result leaves nothing for the row to tell apart, so that call folds. A group that would hold exactly one command and nothing else is that command's own row, `● Bash(...)` with its output under it, not a counted line; once a second call joins, the first command's output is no longer shown in the line (it stays in Ctrl+O), which keeps the height of the open line the same however the run goes. While a command runs it is in the live area as before and the open line stays open; the line is drawn the same live, resumed from the log and in the tests (`group-rows.ts`). A call to a tool that does not exist is not counted: it is its own row, `The model asked for a tool that does not exist (ls). It will try another way.`, with the kernel's own text behind Ctrl+O. A call that fails is counted like the others and stays in the line, which shows no error text; the detailed transcript shows that call with its error, in the error colour. A call the person refused keeps its own row, which ends the line. A hint that is longer than 300 characters is cut with `…`, and it wraps under the line instead of being cut at the terminal width. The CLI `tool-end` event includes optional `output` containing retained tool text before preview formatting; the built-in event adapter supplies it, and the `tool-start` event carries an optional `fold` describing what a call is to the line. Background job reads and stops identify the action and job instead of displaying JSON arguments. Reading job output is not an interactive terminal wait or a write to stdin; those operations are not provided by the current job tool.

A read, search or file listing that the kernel described in fields (`ToolResult.facts`) is headlined from them, as the Desktop does: `Read a.ts`, `Searched for x · 2 matches in 2 files` (a file is named by its own name, never its full path).

An edit or a write draws the change with line numbers, full-width colour and word highlights. The call row is `● Update(src/a.ts)` for an edit or `● Write(src/a.ts)`, the path relative to the working folder. Under it the `⎿` row says `Added 2 lines, removed 1 line` (the numbers bold; `Removed 1 line` when nothing was added; `line` when exactly one), with the counts the kernel measured over the whole file (`facts.added`, `facts.removed`). The hunks sit under that row, in the column its words start in (the same column a shell call's output hangs from, and the same for a created file's lines and for any other result body), with no rule beside them, as many as the kernel carried:

- each row is a line-number gutter (the number right-aligned to the widest in its hunk plus one, then a space), the marker `+`, `-` or space, and the code straight after it with no space between. The first number of a hunk is the line the hunk starts at in the file before the change (`oldStart`); a context or added row takes the counter and advances it, a removed row takes it without advancing it, and the added rows that replace a removed run start at the number the run started at;
- an added or removed row is filled to the full width with a background (`diffAdded` green, `diffRemoved` red) and the theme's text colour; a context row has a dim gutter and plain code and no fill; hunks are joined by a dim `...`;
- a removed row followed by an added row is compared word by word, and when no more than 0.4 of the pair's characters differ the changed words get the stronger `diffRemovedWord` / `diffAddedWord` background;
- a long line wraps inside the width and the rows it continues on keep a blank gutter; a line past 2,000 characters is cut with a dim ` … [+N chars]`; tabs expand to stops of eight;
- colours come from the active [theme](themes.md). In the default dark theme they are `rgb(34,92,43)` / `rgb(122,41,54)`, words `rgb(56,166,96)` / `rgb(179,89,107)`, dimmed `rgb(71,88,74)` / `rgb(105,72,77)` on a terminal that reports truecolor (`COLORTERM=truecolor|24bit`, Windows Terminal and the usual truecolor programs), and the named ANSI colours (`green`/`red`, words `greenBright`/`redBright`) elsewhere. Each theme carries its own pair (`diff.truecolor`, `diff.basic` in `theme-palettes.ts`); the colorblind-friendly themes use blue for added; `DIFF_COLORS_TRUECOLOR` and `DIFF_COLORS_ANSI` in `theme.ts` remain the dark theme's values.

An edit has no row cap; when the kernel itself carried only part of a very large change, a dim `… more changes are not shown` ends the body. A created file reads `Wrote 14 lines to notes.txt` (the count and path bold), then its first 10 lines as plain code (no gutter, no markers) and `… +4 lines (ctrl+o to expand)`; an overwrite reads as an edit. A write or edit the person declined keeps `You declined this, so it did not run.` and then shows what it would have changed with the dimmed colours (an edit as hunks numbered from where the old text sits in the file, with no word highlights, and numbered the same way when the conversation is resumed or forked; a write as its first 10 lines). A conversation saved before facts existed has no hunks and keeps the counts the receipt carried (`Added 2 lines, removed 1 line`) with no body. `/diff` draws the working-tree patch with the same renderer, a heading per file, and folds after 40 rows. A filled row is the same width whether the row is still live or already in scrollback, so no filled row ends in `…`; the height the live window reserves for a change is counted from the rows actually drawn, wrapped lines included.

A settled tool row is one shape: `●` (green when it worked, red when it failed, dim when the person declined or cancelled) and the call, then `⎿` for what came of it. The elapsed time shows only from 1 second up; an instant tool shows none. A tool error names the file as the model gave it or relative to the working folder, `~/x` under the home folder and the full path elsewhere, never `../../x` and never a raw scratch path, and a path too long for the row wraps after a `/` or `\` instead of in the middle of a name.

A failed call has two shapes. A missing file, and a refusal of a read, edit, write, notebook edit, search or language call before it did its work (input it could not use, text that is not there, a copy gone stale), read as a short text on the `⎿` row, in the error colour, with the tool's own message behind Ctrl+O: `File not found`, `Error reading file`, `Error editing file`, `Error writing file`, `Error editing notebook`, `Error searching files` or `LSP operation failed`. An edit on a file that was never read reads `File must be read first` in the dim colour, because it is advice and not a fault. Every other failure, including a permission error, a timeout, a directory read as a file and a blocked call, shows the tool's own error text under the call as `Error: <text>` in the error colour: the first 10 lines, then a dim `… +N lines (ctrl+o to expand)`, every line when expanded. An input-validation error (a call whose arguments do not fit the tool's schema, or that has none) is recognised by the kernel's typed reason `invalid_arguments`, not by its wording, and reads `Invalid tool parameters` until expanded (the full text is on the Ctrl+O screen), and a call with no text reads `Tool execution failed`. There is no `failed:` lead word. A command that fails shows its own output the same way.

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
● Web search("OpenClaw agent runtime built on pi-agent-core framework")
⎿ Did 1 search in 9.0s
● Web search("OpenClaw embedded runtime")
⎿ Found 3 results in 4.1s
● Web fetch(https://docs.openclaw.ai/agent-runtime-architecture)
⎿ Received 7.5KB in 1.2s (ctrl+o to expand)
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
is drawn like any failed call (below).

## Code blocks

A fenced block in a reply is drawn as its lines with a blank line above, and nothing beside them: no rule at the start of a line and no language word above the first. A block with no language, with a language we do not know or with a plain-text one (`text`, `txt`, `plain`) is drawn in the accent colour; one with a language we know is drawn in syntax colour (below). What the screen shows is what a mouse selection takes, so a command selected and pasted into a terminal is the command alone. `/copy` still offers each block exactly as it was written.

A fence is read the way people and models write it, by one grammar that the parser, the live reply, the fullscreen window and `/copy` all share (`markdown-fence.ts`):

- It opens at three or more backticks or three or more tildes, indented, followed by an optional info string. The language is the first word of the info string (`c++`, `objective-c`, `shell-session` and `f#` are languages); a title, a file name or attributes after it are not read. A backtick fence whose info string holds a backtick is inline code, not a fence.
- It closes at a line of the same character, at least as long as the opener, with nothing after it, or at the end of the text. A block opened with four backticks therefore holds a three-backtick fence as its content, and a closing fence longer than the opener still closes. A closing fence may be indented up to three columns more than the opener.
- The code loses the opener's indentation and nothing else.
- Inside a quote the fence is read after the `>` is taken off, so `>   ```sh` is a block indented two columns inside the quote.

A block written inside a list item (its fence indented under the item) is drawn at the indentation of its fence, so it stays under its item, with no blank row between the item's line and the block (a blank row follows the block, before the next item, as after any block). A list is flat on this screen, so the block is a block of its own at that indent, not a part of the item, and a block under a nested item is drawn at its own written indent. The block model reads any indentation as the container's: a fence indented four columns or more with no list above it is a fence here, where a strict reading would call it an indented code block. A long code line wraps in the width that is left after the indent, in both screens. In the fullscreen window the indent is part of the row but a copy that joins wrapped lines starts after it; on the default screen a mouse selection takes the indent as spaces, the same as the gutter.

A reply that is still being written never shows a fence as text that is replaced: one or two backticks or tildes at the start of a line wait for a third, an opener line waits for its end, and a line inside an open fence waits for its end because it may be the closing fence. A long block cut into printed parts keeps its opener line (character, length, indent) so the rest of it is read as the block it was, and the colour state described under syntax colour.

### Syntax colour

A block whose language word names a grammar we have is drawn with keywords, strings, numbers, comments, the names of functions and types, literals (`true`, `null`) and, in a `diff` block, the added and the removed lines each in a colour of the theme. Every other character is in the normal text colour. The characters of every row, the wraps and the widths are exactly those of the same block drawn without colour, at every width, on both screens; nothing is added beside, above or below the block, and what a mouse selection or `/copy` takes is the code. Inline code is not coloured.

The highlighter is the open-source library highlight.js (pinned to 11.11.1). It is read in pieces, one file per language behind its own dynamic `import()`, so nothing of it is loaded before a reply holds a block in a language, and the first frame, the module count at start and `--version` are as they were. The languages are the library's own common set (bash, c, c++, c#, css, diff, go, graphql, ini, java, javascript, json, kotlin, less, lua, makefile, markdown, objective-c, perl, php, python and its console, r, ruby, rust, scss, shell sessions, sql, swift, typescript, vb.net, wasm, xml, yaml) plus `dockerfile` and `powershell`, under the names people write after a fence: `js`, `jsx`, `ts`, `tsx`, `py`, `rb`, `rs`, `sh`, `zsh`, `yml`, `toml`, `html`, `md`, `c++`, `c#`, `golang`, `jsonc`, `patch` and the rest of each grammar's own aliases (the list is `NAMES` in `code-highlight.ts`). The rule for the set: a grammar is shipped only after the stress inputs of `code-highlight-stress.test.ts` (long runs of one character, of quotes, of backslashes, of opening brackets, unterminated strings and comments, nested templates) have been run against it. A grammar a grammar embeds is loaded with it (`xml` for `markdown`, `bash` for a shell session); the CSS, GraphQL and HTML a JavaScript template literal may embed are not loaded, and stay in the normal colour.

**Loading is not a race anyone can see.** A printed row cannot be drawn again, so a block is never printed plain because its grammar arrived a moment late. The grammar starts to load when the fence line has ended (the language is known), and the printing of the block's rows is held until it has arrived or has failed, for at most 1.5 seconds; after that the language is plain for the rest of the session and a block that waited is printed as it always was. A reply that has already ended waits the same way before it moves into the scrollback (it is drawn in the live region meanwhile, and takes its colours there). A reopened conversation does the same on its first paint, and `namzu watch` reads the grammars of the rows it is about to print before it prints them. A grammar that cannot be read (the install was replaced under a running session) or that throws is plain for the session: no crash, no line on the screen.

**Colours come from the theme.** Every theme has a `code` group of nine colours (`keyword`, `string`, `number`, `comment`, `name`, `type`, `literal`, `added`, `removed`; see [themes](themes.md#code-colours)). The colour-blind themes tell an added line from a removed one by blue against orange, never red against green alone; the 16-colour themes use only the terminal's named colours; colour is never the only sign of anything (an added line begins with `+`). A change of theme recolours what can still be redrawn (the fullscreen window and the live region). Under `NO_COLOR`, `FORCE_COLOR=0`, a dumb terminal, a CI run that did not force colour, or output that is not a terminal, no colour is written for code and no highlighting is done; a block is the accent-coloured block it was.

**A line gets the colours the finished block gives it.** A block that is printed in parts while it is written is coloured part by part from what is above it: each printed part carries the open lines above it (a block comment, a template literal, a docstring that is not closed yet) and the characters of code the reply has spent, so a line is coloured as the whole block would colour it. Two limits are stated, because they are the library's: a token that it decides by reading several lines ahead (a Rust raw string, a Ruby heredoc, a YAML block scalar) is coloured from what is above it when the part is printed, so a cut that falls inside such a token can colour its first lines as code, where the finished block colours them as the token; and an unclosed construct longer than 8,000 characters is not followed (the rest of its block is drawn in the accent colour). The unfinished part of a reply is coloured from the same context on every paint, so what is redrawn is what will be printed.

**The cost is bounded.** A block is read in windows (up to 32 lines or 4,000 characters, closed where the library is between tokens and the lines above do not change when the next eight are read with them), and a block that is being written is read again only from its last closed window, so the work of a paint follows the lines that arrived, not the length of the block. A finished block is remembered by its language and text (about half a million characters in all, oldest first; the colours are the block's kinds, which carry no theme, so a theme change cannot show stale colours). Three rules end the colouring at a line, each a rule about what is above the line, so a block drawn whole and in parts agree: a line longer than 400 characters (100 for `ini`/`toml`), or with an unbroken run of more than 100 letters and digits (a blob, not code); a block past 80,000 characters; a reply past 250,000 characters of fenced code. From that line the block is drawn in the accent colour, silently. The worst inputs for each grammar at these sizes were measured with the longest single call of the library at about 20 ms on the machine this was developed on, and the cost of an adversarial 80,000-character block at about half a second in all; the test asserts the decisions (what is handed to the library, and in what size), not the times.

In the fullscreen window a wrapped coloured line still copies as one source line, and a search match is drawn on top of the syntax colour (inverse, the colours under it kept). The two screens draw the same colours for the same block, and a reopened conversation the same as the live one.

`tui.syntaxHighlight: false` in your own config files (or the **Code colour** row of `/config`) draws every block as it was drawn before there was syntax colour. Default on; only an explicit `false` turns it off. A project file's value is ignored.


## Headings, quotes and rules

A reply's headings differ by level with attributes every terminal has, all
bold: level 1 is underlined in the accent colour, level 2 the accent colour,
level 3 the body colour, and levels 4 to 6 the muted colour. A heading has a
blank row above it, wraps to the width as other text does, and keeps its
`code`, links, bold and italic.

A block whose lines begin with `>` (after any spaces) is a quote: a `│` in the
border colour and one space on every row it takes, wrapped rows included, with
its text in the body colour and in italics. The wrap width is the width less
those two cells. A quote may hold paragraphs, lists, a table, a fence and
another quote (two bars); a line that is only `>` is an empty row with its bar.
A `>` that is not at the start of a line is text, and a line without one ends
the quote. A line of three or more `-`, `*` or `_` alone on a line (spaces
between them allowed, so `- - -` is a rule, not a list) is a rule: a line of
`─` in the border colour, as wide as the text up to 40 cells, with a blank row
above and below. `--` is text, and so is a run of marks until its line ends (`***` may be the start of `***bold***`), so a streaming line never flashes as a rule and back. A reply that ends in a rule with no newline after it shows the marks until one arrives. `---` lines around `title: x` (front matter) are two rules with text between. A list is flat, so a `>` line under an item is a quote of its own, not part of the item. `Title` over `---` is a paragraph and a rule, not
an underlined heading: reading it as a heading would turn the paragraph into
one when its third dash arrived on a reply still streaming. Nothing inside a
fenced block is read as a quote or a rule. The fullscreen window draws the same
(`markdown-structure.ts` holds what both screens read).

```text
Level one          (underlined)
│ A quoted paragraph that wraps, and the bar
│ is on every row it takes.
│ │ a quote inside the quote
────────────────────────────────────────
```

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
moment its separator line has ended: a lone `| a | b |` line is held back until
the line after it shows whether it is a header, a row is drawn only once
it is complete, and a line with a pipe after the separator stays a row of the
table rather than falling out below it as a paragraph. A column is as wide as
its widest cell in the header and the complete rows, so it widens only when a
complete row needs it, never word by word, and a table is printed into the
transcript once complete exactly as it was last drawn. A table too wide for a
box is drawn as records, and which it is cannot be known before its widest row
has arrived. A list item or a
blockquote ends the table even when it carries a pipe, as a blank line, a
heading or a fence does: `- a | b` directly under a table is a list item.

## A reply as it is written

The text of a reply is drawn as it arrives, at most about twelve times a second
however fast it comes, the first words at once and nothing at all while nothing
arrives. What is drawn of the part still being written is only what is decided,
and what could still become something else is held rather than drawn as the
source it will stop being:

- prose (a paragraph, a list item, a heading, a quote) is drawn in whole words;
  the word still arriving waits for its space;
- an opening `` ` ``, `[`, `**`, `*`, `__` or `_` that has not closed holds the
  text from it on until its closer arrives (a lone `*` pairs with a later one
  wherever it stands, so it waits too; a wait is let go after 300 characters and
  the text drawn as it is);
- a line of only `-`, `*`, `_`, `+`, `=`, digits (with `.` or `)`) or `#`, still
  arriving, is not drawn until its line ends or text follows: it may be a rule, a
  list marker, a heading or an underline;
- a line that opens a code fence is not drawn until it ends (it may be inline
  code); inside an open fence the code is drawn as code, a line at a time;
- a table is drawn as above.

When the turn ends nothing is held: the rows in the transcript, in a reopened
conversation, in `namzu watch` and in an export are the rows the whole reply has.

In the default screen a block that is finished is printed into the transcript
at once and is never drawn again, so it moves into the terminal's scrollback
like any finished row and the live part holds only the unfinished tail. A heading,
a list item and a rule are finished when their line ends; a paragraph, a quote,
a table and a fenced block when a blank line has ended after them or the next block
has begun on a line that has ended. Everything before the reply, the person's
message included, is printed when the reply starts, so nothing is ever missing
from both the screen and the scrollback, at any window size. A long tail with no
break in it is cut: the earlier lines of a code block, and the earlier whole rows
of a paragraph (at a point where no emphasis, code or link is left open), are
printed once the live part would pass ten rows at a short window (up to fourteen at
a tall one), and the live part keeps its last three. A table, a long list item and a quote are not cut, so
one taller than the window is still clipped at its top until it is complete. A
reply that a retry voids after parts of it were printed stays above the new
attempt, since printed rows cannot be taken back, with one row under it that
says "The reply above was dropped; the answer starts again below." (a reply
with nothing printed is taken back as before, and the saved conversation holds
only the answer that finished). A rule under text (`---`, `***`, `- - -`) and a
list marker inside a quote wait until they are decided, in both screens. Rows printed before a
resize keep the width they had. The fullscreen view draws the same tail and
prints nothing, since it redraws freely.

A very long reply is a matter of cost, and the cost follows the reply, not its
square. The program that draws the screen is built to run React's production
build (`process.env.NODE_ENV` is fixed to `"production"` in the text of the
bundle, `packages/cli/scripts/bundle-options.mjs`). Before that it ran the
development build, which keeps a record of the props of every component it draws
(and a reply's text is a prop) for the life of the process: memory grew with the
square of the reply, about 1.7 GB for 100 KB and the end of the process, "JavaScript
heap out of memory", for 200 KB. The environment of the shell tool is not written
to. Measured on the default screen at 120x40 (a fake model on loopback, text
arriving 480 characters every 60 ms): a 100 KB code reply 8.9 s of processor and
1.7 GB, now 3.8 s and 0.44 GB; 200 KB ended the process, now 5.1 s and 0.53 GB; 1 MB of code
19 s and 1.2 GB, 1 MB of prose 21 s and 1.5 GB (they ended the process before). In the fullscreen
view the lines of a growing code block are kept too (a line's rows depend on the line, the width,
the indentation, its colour runs and the theme), where every line was cut and coloured again at
every piece: 1 MB of code 125 s and 2.7 GB before, 38 s and 2.7 GB now; 1 MB of prose 139 s before,
32 s now (processor seconds of the whole process, startup about 1.3 s included).

## The model's plan

`task_create`, `task_update` and `task_list` draw one checklist, and it lives
in the working region while the turn runs: under the working line, updated in
place as the model changes the plan, so each task is on screen once and the
transcript gets no block per update. The default screen cannot redraw a row it
has printed, so the list is part of the live region there (the same component
draws it in fullscreen). While a planning call runs, the working line says so in
plain words (`Updating the plan`, `Adding to the plan`, `Reading the plan`),
never the call's own text. When the turn ends, the list as it ended is printed
once into the transcript, with a `Tasks · 2/3 done` header, if the plan changed
during the turn; a turn that did not touch it prints nothing. A short terminal,
which has no room for the list, keeps the one-row current step below the
working line instead. No task id, owner or JSON appears on any surface: the
model still receives the ids in its tool results, which the screen does not
show.

The `Tasks · …` header is the CLI transcript group's checklist progress.
The SDK's generic presentation of an individual `task_list` result instead
qualifies its scope as `Current-turn task view · …`. The model-facing result
also reports how many earlier terminal records remain stored outside that
view; see [Task context](task-context.md).

While a turn runs the live checklist shows every task (at most five rows, the rest counted as `… +N more`); Ctrl+T folds it to the one current step, and the footer names the key (`ctrl+t to hide tasks` / `ctrl+t to show tasks`). Between turns, with the plan not in view, the folded one-row step is the default and Ctrl+T opens it. The choice is saved as `tui.showExpandedTodos` in your own config files; a project file cannot set it.

One renderer draws every checklist, the printed block and the live checklist alike:
`□` pending, `■` in progress (bold), `✓` completed (dimmed and struck
through), `✗` failed, each followed by exactly one space, with a wrapped subject
hanging under its first letter. The printed block shows
its plan inline in the conversation, once, after the turn that changed it.
Outside a running turn, a single row above the composer names the current step
and the count (`■ Write the parser · 1/3 done`) only while that block is out of
view — pushed up by later output, or taller than the space left on a short
screen. It leaves when no step is open.

## Reading the conversation

The `›` mark identifies an operator message and `∴` identifies a Namzu reply.
An operator message is the one row block with a ground of its own: on a terminal that draws at least 256 colours (truecolor, or `TERM` naming 256 colours) the whole block, gutter and every wrapped row, sits on a quiet tint (dark green-grey in the dark theme, pale green-grey in the light one, blue-grey in the colorblind-friendly pair) and its `›` is dimmer than the text instead of bold, so the message is easy to find again when scrolling back through a long conversation. A message that is queued and not sent yet (the `❯` row above the composer) is on a plainer grey. The tint is drawn behind the words only, never padded out to the edge of the screen, so a copy from the terminal carries no trailing blanks and a resize has nothing to re-wrap; in the [fullscreen view](#fullscreen-mode) copy reads the row text, which never held the tint. With `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb`, a CI run that did not force colour, a terminal of 16 colours or fewer, or one of the `-ansi` themes (which paint no background of their own) the block looks as it always did: a bold `›` and no tint. On a terminal of 256 colours without 24-bit colour the tint is a step of the grey ramp (235, queued 236; 255 and 254 in a light theme) because rounding the near-black value to the colour cube would give a mid grey. A reopened conversation and `namzu watch` draw the same rows, so they carry the tint too (`namzu watch` writes the background and the dim `›` as escapes around the words, only on a terminal and not in `--plain`). The tint is a theme token (`tint.user`, `tint.queued` in `theme-palettes.ts`).
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
silently. Each visible line is shortened to 240 characters (never through an emoji), and Ctrl+O is
advertised whenever text is hidden, in one wording everywhere (tool output, the shell cell, an agent's
answer): `… +N lines (ctrl+o to expand)`, with `(~N KB)` after it once at least 1,000 characters are
hidden, and `line` for exactly one. In the [fullscreen view](#opening-a-row-with-a-click) with the pointer at `full` the same hint reads `(click to expand)`. Ctrl+O opens the detailed transcript, which shows the retained body whole; `/raw` also
includes it. Runtime output limits still apply: a retained artifact path
identifies output beyond those limits. Neither action re-executes the tool.

File-discovery calls name both the glob pattern and its directory. A shallow
`*` search is visibly distinct from recursive `**/*`; result and traversal
limits add an explicit incomplete-search notice. See
[Bounded file discovery](../sdk/file-discovery.md).

The writing area is two plain horizontal rules, `─` in graphite, with the input
between them: no side borders, no corners and no title.
The input line starts with a dim `❯ ` (`…` while the composer is paused), and
the placeholder, the effort, model and trigger
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

The working line is a small mark, a word and figures: `● Working (46s · ↓ 1.1k tokens)`.
The mark is our own, a disc that shrinks to a point and swells back in four
shapes about every two seconds (`● • · •`); it holds still, as `●`, under
reduced motion, with `NO_COLOR`, `FORCE_COLOR=0`, `TERM=dumb` and for a screen
reader. The word has a repeating green fill and pale leading edge, and says the
phase in plain words where the kernel knows it: `Thinking` (reasoning is
streaming), `Writing` (reply tokens are arriving), `Running a command`,
`Running grep` (a tool by its plain name), `Running 3 tools`, `Waiting for an
agent`, `Updating the plan`, `Waiting for your approval`, `Retrying` (with its
own countdown row below), `Compacting conversation…`, and `Working` when no
phase is known; with nothing arriving for 3 s it reads `Waiting for the model`.
The clock is on the line from the second second of the turn and never leaves, so
nothing pops in later; the output tokens, agents and a note about silence join
it in the same parentheses. Elapsed time reads `12s`, `1m 23s`, `2h 3m 4s`
(seconds floored, the same format on every duration in the transcript). The
clock moves once a second even under reduced motion (not for a screen reader).
With no plan list on screen (a short terminal), a plan step in progress still
gives the word its place: the step, in the words the model gave for it (`Running
the tests`) or its subject. The model is also told to say in a line what it is about to do before its first tool call and to add a one-line update when it finds something, changes direction or hits a blocker, so a long turn reads as a few plain lines and not as silence. A blank
row separates the last transcript row from the Working row. When nothing has
arrived for 10 s the figures say so in words, `(32s · no reply for 22s)` (`no reply yet` only when no token has come since the turn began, never once some text has arrived), and the
label blends toward `rgb(171,43,63)`, fully at 20 s, easing in and out; colour
only backs the words up, and neither shows while a tool runs, the model is
thinking, a compaction runs, a retry is being waited out or a question waits for
you. Both reset on the next token. The line never says "network" or blames a
cause the kernel does not know. The reasoning row under it names how long one stretch has run: `thinking`, `still thinking` from 10 s, `thinking more` from 20 s, `thinking some more` from 30 s, `deep in thought` from 45 s, followed by the model's own summary when it gave one; when the stretch ends the row reads `thought for 12s` (whole seconds, at least 1) for two seconds. The count is the provider's reported output
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
plan is the list under the working line described in
[The model's plan](#the-models-plan); only on a terminal too short for it is it
one line, the current step and the completion count (on a narrow screen the step
alone). The plan list, the running calls and a queued message are counted into
the room the unfinished part of a reply may take
([A reply as it is written](#a-reply-as-it-is-written)), and these panels also
reserve space before the transcript keeps any older messages in its redrawable
tail.

### A resumed conversation

`namzu -c`, `namzu resume <id>` and the `/resume` picker show what the live run
showed, not only the messages: the same tool rows (a read's `Read a.ts`, an
edit's `Update(a.ts)` and `Added 2 lines, removed 1 line` with its diff body, a write's `Wrote 2 lines to n.txt`, a
command's cell with its output behind Ctrl+O, a failed call's one-line reason),
the `Worked for 46s` line that closed a turn, `Interrupted.` for a turn the
operator stopped (and the one-line reason for a turn a limit stopped), and the
rows of the agents it launched, placed after the reply that launched them once
the saved children are read. A call that never reported a result reads
`○ Bash(sleep 99)` over `⎿ Interrupted`.

Nothing is drawn twice: the rows come from the same builders the live path
calls (`tool-end-rows.ts` for a finished call, the agent rows in
`agent-transcript-rows.ts`), so a later change to how a row reads reaches both.
`restored-rows.ts` replays the conversation's journal through the live
translation (`toAgentEvent`), which keeps the kernel's typed facts and timings.
A conversation without a journal (a `/branch`, an older log) is drawn from the
saved messages: the file a read, edit or write named still shows, a write's
counts are read from its receipt, and the elapsed time and the closing line are
left out because the messages do not keep them. A delegation that succeeded
leaves no tool row, as live: the agent rows own it; a failed launch keeps its
row.

A reopened conversation is not identical to the screen it was saved from, in
three places. The plan checklist block (`Tasks · 2/3 done`) is not shown again:
the live screen prints it once, when the turn ends, but the saved record does not
hold it. The closing rows can sit in a different order: live, the checklist and
then `Worked for` come after the changed-files row; reopened, there is no
checklist and `Worked for` follows the changed-files row directly. And one
`Resumed:` row, with a blank row after it, is added at the end. Everything else,
a 500-line code reply included, is row for row the same.

The plan checklist is printed once, when the turn ends, after the reply and the
changed-files row: it is not in event order. While the turn runs the plan lives
in the working region and is redrawn in place; the transcript gets no block for
each change.

A reply cut off in the middle of a table ends the table at its last whole row.
What was written of the row still being written stays under the table as one
line of plain text (it is what the model wrote, and it is in the record); it is
never drawn as a row of empty cells.

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
says what is new, with the same counter and wording as the fullscreen hint
([below](#what-the-hint-says)): `2 new replies · ↓ Back to bottom · esc`, then
`2 new replies · ↓ Bottom · esc`, `2 new · ↓ Bottom`, `2 new ↓`, `2`. Only
replies of the model with text count, not tool calls; a reply that was being
written and has grown is `Reply still growing · …`; anything else below is
`New activity · …`. The count starts when the box opens and goes when it closes.
Rows come from
`transcript-scroll.ts`; `TranscriptScrollView.tsx` draws them; `Composer.tsx`
opens it. Covered by `the-transcript-scrolls-back-and-returns.test.tsx` and
`the-transcript-scrolls-from-the-composer.test.tsx`.

### Fullscreen mode

An opt-in alternative to the terminal's scrollback. Set `tui.fullscreen: true`
in your own config (a project file cannot turn it on) or start with
`NAMZU_FULLSCREEN=1`; `NAMZU_FULLSCREEN=0` turns it off whatever the config
says. Absent, nothing changes: the transcript goes to the terminal's
scrollback exactly as before. It is also off when output or input is not a
terminal and inside a `namzu workspaces` host, which owns the alternate screen
there.

On, the app takes the alternate screen when it starts and hands the main
screen back, untouched, when it ends. The launch no longer clears the screen
and its scrollback, so what was above the prompt is still there afterwards.
Leaving works the same on `/exit`, SIGINT, SIGTERM and SIGHUP, and a process
that dies mid-frame still writes the pointer and cursor reset. The external
editor gets the main screen for as long as it runs.

The conversation is a window onto rows like the scroll box above draws: a glyph
gutter, wrapped text, a blank row between entries. A reply is drawn as
Markdown, the way the normal transcript draws it (headings, lists, code blocks
with nothing beside them, tables, inline styling), from the same parser,
wrapper and table layout; a code line too long for the row is cut as the normal
transcript cuts it (`fullscreen/code-wrap.ts` holds the same rules as Ink's
`<Text wrap="wrap">`, and a test draws many lines both ways and requires the same
rows). The rows are made while the window renders, so nothing here may start a
second render: Ink's `renderToString` called from there left the layout engine
holding an update for a freed node and stopped the program with `table index is
out of bounds` in any window narrower than a code line (every code block at 80
columns). A streamed reply is laid out again at each piece, so the rows of the
blocks that did not change are kept (up to 4,000,000 characters of blocks, oldest out; a count of 48 blocks was smaller than the blocks of a long reply, so each was laid out again at every piece and 200 KB of prose cost about three times the time of the same text laid out once) and the plain
wrap of a reply's whole text is not made at all; a line of 50,000 characters
costs the window the same as a short one, the text stays complete for copy and
search, and a key is echoed in under 100 ms while such a reply streams. A reply of 1 MB of code is the edge of what the view is built for: it finishes, but one key echo was measured at 250 ms and the process peaked near 2.6 GB (the kept rows hold one object per run of text, so their memory follows the reply, not the 4,000,000-character bound on their keys). Other
messages are plain wrapped text. A `⎿` result line (an interruption, a declined call, a tool's result) hangs in the same columns as in the normal transcript: the mark in the third cell and its words from the sixth, with a wrapped line under the words; the mark is part of the row text, so a copy of such a row includes it. Only the rows that fit are built into elements, so the
cost of a frame follows the terminal's height, not the conversation's.
Messages are laid out once per width and kept. The spinner, composer and
footer are pinned under it and the window takes the rest of the height; the
frame is always one row short of the terminal so the renderer never takes its
clear-everything path (see `ViewportBound.tsx`). The renderer is asked for
incremental repainting, so only changed lines are written.

| Input | Does |
| --- | --- |
| Mouse wheel | three rows up or down for a slow notch; a fast run speeds up and the view glides ([below](#the-wheel)) |
| PgUp / PgDn | a page, one row less than the window |
| Home / End | the first row, and back to the latest, while the composer is empty |
| Typing or Enter | back to the latest |
| Drag | select text, shown inverted; on release it is copied |
| Double click, triple click | select a word, select a line |
| Click on a folded row | open it where it stands; click again to fold it ([below](#opening-a-row-with-a-click)) |
| Esc | let go of the selection, or close the search |
| Alt+S | search the conversation |

Reaching the end resumes following. Scrolled up, the view holds still while
output arrives, and one row above the composer says so and counts what came
([below](#what-the-hint-says)). Clicking that row jumps to the newest row and
follows again. The reader's place is a message and
a row inside it, not a row number, so a resize that re-wraps everything keeps
them on the same text; if a compaction replaced that message the view returns
to the latest. After a resize the screen is erased by the renderer that drew it
and drawn whole once the size has settled, so no old frame is left under the
new one. The terminal is asked for button reports (wheel, presses and drags);
they are taken off the input before the composer sees them.

#### The wheel

A notch is not a jump. Every notch adds rows to a distance still to travel,
also when several arrive in one chunk of input, and the view spends that
distance over the next frames: each frame covers half of what is left, all of
it when two rows or fewer are left, and never more than one window less a row.
A move is a glide of a few frames that lands exactly. The first frame is at
once (scrolling up stops following at the first notch, before the glide ends),
and while a distance remains a frame is painted every 44 ms, on its own timer,
so a glide does not wait on unrelated renders; each frame writes only the rows
that changed. The period is longer than the renderer's own 34 ms limit on
purpose: at 34 ms a frame can land inside the limit and wait for the next, so
two frames are painted as one 68 ms jump. Keys are immediate: PgUp, PgDn, Home and End end a glide where it
stands and move at once, opening search ends it where it stands (closing
search returns to that place), and so does a press of the mouse (a click on a folded
row opens the row under the pointer, not one a frame ahead of it). Output that
arrives during a glide does not move what is on screen.

| Case | What the view does |
| --- | --- |
| One slow notch | 3 rows (`tui.wheelRows`), two frames |
| Several reports in one write (a terminal that sends 2 or 3 per notch) | each is a plain step (`tui.wheelRows` each) and they do not count as a faster run; set `wheelRows` to 1 to move 3 rows a notch |
| Notches less than 120 ms apart | a run: notch number n of the run moves `rows + (window - 1 - rows) * (n / 9)^2` rows, so 3, 3, 4, 6, 9, 12, 16, 21, 26, 32 in a 33-row window, which is what a 40-row terminal shows (a window less a row from the tenth notch on) |
| A gap of 120 to 500 ms | the run is halved |
| A pause of 500 ms or more | back to the plain step; what is still to travel is finished |
| A change of direction | what is left to travel the old way is dropped and the notch is a plain step the other way |
| One notch the other way inside a run of 3 or more | held back: it moves nothing and the run goes on (some wheels bounce); a second one is a change of direction |
| A very fast run | the distance never runs more than four windows ahead of the view, so the view stops soon after the hand does |

The numbers are in one place, `WHEEL_FEEL` in `fullscreen/glide.ts`; the
arithmetic is pure (`notch` and `frame`) and is tested with a table.

Two settings, in your own config files only (a project file's are ignored):

```yaml
tui:
  wheelAccel: true   # false: every notch is the plain step, however fast
  wheelRows: 3       # rows per notch, 1 to 20; lower it where a terminal sends several reports per notch
```

Both are rows in `/config` (**Wheel speed-up**, **Rows per wheel notch**). With
reduced motion (`tui.reducedMotion`, `NO_COLOR`, `FORCE_COLOR=0`, a dumb
terminal) there is no glide: a notch moves the view in one frame, and the
speed-up still applies unless `wheelAccel` is off. The default screen does not
read the wheel, so none of this holds there.

#### What the hint says

Scrolled up, the one row above the composer counts the replies that arrived
since you scrolled away. A reply is a message of the model with text to read:
tool calls, status rows and empty replies are not counted, and a reply that was
being written when you left and has since grown is not new. Centered, in the
longest form that fits, never cut inside a word:

| News | Wording, longest to shortest |
| --- | --- |
| none | `↓ Jump to latest · End`, `↓ Latest · End`, `↓ Latest`, `↓` |
| 1 or more replies | `2 new replies · ↓ Jump to latest · End` (`1 new reply`), `2 new replies · ↓ Latest · End`, `2 new · ↓ Latest`, `2 new ↓`, `2` |
| the reply only grew | `Reply still growing · ↓ Jump to latest · End` while it is being written, then the same ladder with `Growing`; once it has finished, `Reply grew · ↓ Jump to latest · End`, then with `Grew` |
| something else below | `New activity · ↓ Jump to latest · End`, then the same ladder with `New` |

The key named is End, which jumps down while the composer is empty; with a draft
in it End moves the cursor, and the click still works. With the pointer at
`full`, a click on the hint row jumps to the newest row and follows again; with
the mouse at `scroll` or `off` nothing is clickable and nothing changes.

While replies are unseen, one quiet rule row stands just above the first of
them and says the count (`──── 2 new replies ────`; on a narrow row `2 new`, then `2`), so after jumping down you
can scroll up to where you left off. It stays when you jump down, and goes when
you send your next message (or when a compaction removes the message it stands
above). A later time you scroll away and replies arrive puts a new rule in its
place. The rule is a row of the transcript with no text: a search does not find
it, a copy skips it, a click on it does nothing, and the reader's place (a
message and a row inside it) does not move when it appears or goes. The counter
is `new-output.ts`, shared with the default screen's scroll-back view.

#### Selecting and copying

With the pointer at `full` (the default; `tui.mouse: scroll` or `off`, and
`NAMZU_DISABLE_MOUSE` / `NAMZU_DISABLE_MOUSE_CLICKS`, keep the terminal's own
selection and leave only the wheel), the terminal reports drags, so a drag
selects text in the window, drawn inverted. A double click selects a word, a
triple click the line; dragging past the top or bottom edge scrolls. The
selection is on rows and cells of the text, not on the screen, so it stays on
its text while the view scrolls and while output arrives below it; a resize,
which wraps the rows again, lets go of it.

On release the text is copied (`tui.copyOnSelect: false` keeps it selected and
makes `ctrl+c` copy it instead, as in `namzu workspaces`). The copy is the
plain text of the rows: no styling, no gutter glyph, no hanging indent. Rows
that one line was wrapped over are joined back into that line, with the space
the wrap broke at or with nothing where it cut a word; separate lines and
paragraphs keep their line breaks. Widths follow the display-width helper the
rest of the interface uses, so a CJK letter or an emoji is two cells and is
never cut in half. The text goes to the machine's clipboard tool and, as an OSC
52 request, to the terminal, by the same copier `/copy` uses; a line saying what
was copied replaces the last row for two seconds without moving any row. `Esc`
lets go of the selection.

#### Opening a row with a click

With the pointer at `full`, a click (the left button pressed and released on
the same cell, no drag) opens a folded row in place, and a click on it again
folds it. An open body taller than the window can push its first line off the
screen; the click that folds it goes on that line, so scroll up to it. The rows that answer are the ones that carry the expand hint, and
the lines that belong to them: a counted line (reads, searches, listings,
folded commands) and the `$ command` rows listed under it open to each call of
the line with its result, as the [detailed transcript](#the-detailed-transcript-ctrlo)
shows that line; a tool or command row whose output is cut, and a collapsed
agent answer or memory row, open to the whole body, on the row itself or on the
`… +N lines` row under it, and anywhere along those rows, blank cells to the
right of their text included. Nothing else reacts: not a reply, not a row with
nothing folded (whatever text it shows, a command's own output that quotes the
hint included, which is drawn as the command printed it), not the text a row opened to (so a double click on a word in
opened output selects it and does not fold the row). A command listed under a
counted line opens the whole line, not that command alone, because the line
keeps the commands' output together.

The hint says what is true. With the pointer at `full` it reads `(click to
expand)`, and an open row says `(click to fold)` after its first line. In the
normal screen, in the scroll-back, with `tui.mouse: scroll` or `off`, and on
the detailed transcript it stays `(ctrl+o to expand)` and a click does nothing.
With the pointer at `scroll` or `off` the wheel is still reported and the
terminal keeps the mouse.

The row you clicked stays on the same row of the screen. A view that was
following the newest output and is pushed off it by the row it opened stops
following, as it does when you scroll up: the `↓ Jump to latest` row appears,
and `PgDn`, `End` or typing take you back. In a conversation shorter than the
window the rows above the clicked one stay as few as they were, so blank rows
show above them, as they do for a short conversation, until you scroll or the
conversation grows past the window. One thing the window cannot hold: a fold
that shortens the conversation while the window shows its end brings the rest
down, because the window never shows blank rows under the newest one.

A click while a selection is held only lets go of it. A double click opens or
folds the row once and then selects the word, and a triple click the line; the
press that starts a drag never opens anything, and neither does a release on
another cell. Which rows are open is kept by the view only: it is not saved,
a resumed conversation starts folded, a resize keeps what was open, a row that
changes while open (more of its output arrives) is drawn again in place, and
the detailed transcript is unchanged. Laying a conversation out is kept per
message and per open state, so opening a row lays out that one message however
long the conversation is (`layout.ts` counts the messages it laid out; the test
pins one for 40 messages and for 160).

Links are not opened by the app. A link in a reply is drawn as plain text with
its address (a Markdown link as `the guide (https://…)`), and the fullscreen
rows carry no terminal hyperlink sequence (checked in the program's output). With the pointer
at `full` the terminal passes the click to the app, and Namzu does nothing with
it on text; the note after a copy already says to hold Shift to use the
terminal's own selection. What a given terminal does with a modifier click on
an address, with or without mouse reporting, was not tried here and is the
terminal's own: select the address and copy it if the terminal does not follow
it.

#### Searching

`Alt+S` opens a one-line search field in the last row of the window and the
composer stands aside. Matches are found as you type, in the rows as drawn:
case is ignored unless the query has a capital letter, and a match lies inside
one row, so a phrase the wrap split across two rows is not found. The nearest
match at or above the bottom of the window is current; matches are underlined
and the current one is inverted, and the window scrolls to put it in view.
`Enter` or `↓` goes to the next match and `Shift+Enter`, `Alt+Enter` or `↑` to
the previous, round the ends; `PgUp` and `PgDn` still scroll. `Esc` closes the
field and returns the window to where it was, or to the latest if you were
following.

While it is on, the `←` workspaces screen is not offered, the terminal's own
scrollback is not available inside the app, and the detailed transcript and
agent views draw in the live area as before. It is not the default. Code:
`packages/cli/src/tui/fullscreen/` (`viewport.ts` the scroll arithmetic,
`layout.ts` the rows, `markdown-rows.ts` the Markdown, `selection.ts` and
`cells.ts` the selection, `search.ts` the search, `paint.ts` the highlights,
`mouse-wheel.ts` the pointer, `glide.ts` the wheel's arithmetic, `mode.ts` the switch, `FullscreenTranscript.tsx`
the window; `new-output.ts` beside it counts what is new); the launcher wires it in `index.tsx`. Covered by `viewport.test.ts`,
`mode.test.ts`, `mouse-wheel.test.ts`, `layout.test.ts`, `click-rows.test.ts`, `markdown-rows.test.tsx`,
`selection.test.ts`, `search.test.ts`,
`a-fullscreen-view-draws-only-its-window.test.tsx`,
`a-click-opens-a-folded-row-in-place-in-the-fullscreen-view.test.tsx`,
`a-fullscreen-window-selects-copies-and-searches.test.tsx`,
`a-fullscreen-wheel-glides-counts-and-marks.test.tsx`, `glide.test.ts`, `new-output.test.ts` and
`a-fullscreen-app-draws-a-window-and-follows.test.tsx`.

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

A call that asks several questions, or one question that takes several answers
(a multiple choice), is a card of its own rather than the plain chooser, laid
out as tabs. A tab for each question shows its header and a mark
(`☐`, `☒` once answered), and a last `✓ Submit` tab reviews the answers
together. On a question, `↑↓` move and Enter chooses: a single choice moves on
to the next question by itself, a multiple choice is toggled with Space or
Enter and left from its last row (`Next`, `Review` or, for a lone question,
`Submit`). The focused option's `preview`, when it has one, is shown beneath
the list in the muted colour (six lines at most). `Something else…` is typed
in place: Enter keeps the text, Esc puts the old text back. `←→` (or Shift+Tab
and Tab) move between questions and keep what was chosen. The review tab says
`You have not answered all questions` when one was left alone, and offers
`Submit answers` or `Cancel`; the questions left alone are reported to the
model as not answered, never guessed. Esc skips the whole call (as does
`Cancel`), Ctrl+C stops the turn. One line per answered question is written to
the transcript when the card closes. A lone single choice keeps the plain
chooser above.

Command, settings, goal, skill, branch and commit menus accept text filtering.
Digits belong to the search query in these menus. Arrow keys navigate and
Enter applies an available selection; non-searchable menus keep their numeric
shortcuts. Esc returns to the parent or cancels, including the rewind
dialog. The first key pressed after a menu appears is accepted; the key that
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
names, after "others:", the other detected providers that Namzu can construct from available
credentials. The list states whether selection affects future launches or only
a session using a temporary credential. The old session remains usable if
replacement construction or preference persistence fails.

`/goal` presents objective management and automatic continuation controls,
including the automatic-turn allowance before work starts. `/tasks` is the
background view, not the checklist; Ctrl+T shows or hides the checklist. The
retained delegated-work view is the cockpit, reached from `↓` or `/tasks`.

The delegated-work view first separates workflows. Independently launched work
in another parent turn appears as a separate workflow, including when names are
reused. Within a turn, explicit workflow labels group phases across tool batches;
unlabelled batches remain separate workflows. Repeated batches in the same
explicit phase do not create new phases. These annotations describe grouping,
not execution dependencies or barriers.

With multiple workflows, the workflow picker opens first. Selecting a workflow
shows its phases, then one phase's agents; Esc returns to workflows and `q`
returns to the conversation. Older completed or cancelled work stays available.
Pending admissions show `Queued` until the child session starts. Completed Agent
and `wait_for_task` outputs name the actual `task_id` and terminal status before
the child result, so identifiers inside that result remain clearly separate.

The agent cockpit (`←` or `↓` from an empty composer, or Enter on an agent row in `/tasks`) is the workflow detail view described
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
agent's row on the rail); `q` returns to the main conversation and
restores the draft. A child that finishes remains readable in the open view and
can be reopened from `/tasks` while retained by the current session.

Messages submitted with Enter while an `Agent` call waits for a child release
that wait so the parent can respond while children continue. Results arrive in
the same turn as task notifications. Tab still queues a future turn; Esc still
interrupts the current turn and its children.

## System rows

Every row Namzu writes about itself shares one marker, a coloured `●` (yellow for something to read, dim for a note, red for a failure), with a `⎿` line for what continues it; `system-rows.ts` holds the one level to glyph and colour mapping, and a system row written with no glyph of its own gets the dim notice dot, so no producer can bypass it. `✻` stays on exactly two rows: the line that closes a reply and `Conversation compacted`. An interruption is one dim line, `Interrupted · What should Namzu do instead?`, hung under the call that was running when there was one (the call's own `● Bash(…)` row is written first, so the line is never left alone under the person's message) and standing alone otherwise; after a send-now steer it is a plain `Interrupted`. Agents, workflows and background jobs end with the same three words, `finished`, `failed` or `stopped`. A copy reads `Copied 1,234 characters (the latest answer) to the clipboard.` when the machine's clipboard tool took it, and `Sent 1,234 characters (the latest answer) to your clipboard. If paste fails, hold Shift while selecting.` when only the terminal's request went out. Peer messages read `Message from alice: …`, goal rounds `Goal, attempt 2 of 5` over the objective, a delivered scheduled run `Scheduled job "nightly-build" failed at 09:12`, and a provider switch names both products and a reason ("OpenAI was too busy, so Namzu used Anthropic for the rest of that reply."; the chain position, HTTP status and code follow only with `--debug`).

`NAMZU_NO_CLIPBOARD=1` turns off every clipboard tool, reading and writing, for the process: nothing is started, each tool counts as unavailable, and a copy falls back to the terminal's request or the notice, as on a machine with no tool.

## Plain words for errors and status

The terminal app speaks in the person's terms. `--json`, `namzu exec`, scheduled runs and the ACP host keep the kernel's structured codes unchanged; this applies to what the interactive screen shows.

- **A failed reply** is one sentence naming the provider by product name ("OpenAI did not accept your API key. Check it in /setup, or pick another provider with /model."), plus at most one `OpenAI said: ...` line when the provider's own message adds information. No bracketed catalog ids, no `Provider:` or `Reason:` rows, no raw JSON, status lines, request ids or config-key names. `plain-interruption.ts` builds it.
- **A paused reply** has one wording: "Paused. OpenAI is having problems on its side. Namzu tries again on its own. Press Enter to try now, or Esc to stop." for a connection that would not hold (no connection or a server fault: the reply continues from its checkpoint by itself after 15 seconds, then 30 seconds, 1, 2 and 5 minutes, then every 5 minutes, and the hint line counts down; Enter tries at once, Esc stops it; every failed try rewrites the one pause line, it does not add another, a pause of a different kind or a new run of tries gets a line of its own and never rewrites an older one, and a try the schedule makes adds no "Continuing" line) and "Paused. … Press Enter to continue, or Esc to stop." for the rest (the same shape for a tool or the browser that needs you: "Paused. The browser needs you: …", with the facts the tool attached as labelled rows such as `Login url: …`; offline and rate-limited have their own wording; a rate limit names the wait as `20s` or `1m 05s`). Enter on an empty composer continues the reply, as it does for a tool that needs a person; `/resume` and `/abandon` still work. The queued rows under a pause say what is waiting: "Something finished in the background" (reported after the reply) and "Waiting for the paused reply to continue, then these run". Typing a new message does what the notice says: a reply that stopped on a provider failure (a rate limit, an outage, a rejected key) is closed by the message, which runs on the model chosen at that moment, so changing the model first needs no `/resume`; the stopped message stays in what the model is shown, and no error line appears. A pause that waits for a person (an approval or a handoff) still holds the conversation, and a message sent then is refused in one plain sentence ("The last reply is paused and waiting for you. Press Enter to continue it, or run /abandon to close it and send your message."). No checkpoint id or turn id is shown in the terminal; headless output (`exec`, scheduled runs) still prints the checkpoint for scripts.
- **A quiet stretch while the provider is retried** is one line under the Working row: a red bullet, what failed, and a dim `Retrying in 5s · attempt 2/10` that counts down once a second. The first two tries of a plain server fault say only "The request failed."; from the third try, or at once for no connection or a rate limit, it names the provider and the cause ("OpenAI is limiting requests."). The terminal retries ten times with a wait that starts at half a second and doubles to thirty-two, honours a named `Retry-After` as a minimum, and does not wait for more than a minute; Esc interrupts the wait. A reply cut off by a dropped connection starts over and the half-drawn text is taken back. It goes away when the provider answers; when the tries run out the reply pauses as below. See [Provider retry](../sdk/provider-retry.md).
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

  The header keeps the command's real line breaks, at most 2 lines and 160 characters, then a single `…`; Ctrl+O shows the whole command. stdout comes first, then stderr in the error colour; each stream shows its first 3 visual lines (10 when the command failed) and then a dim `… +N lines (ctrl+o to expand)`; a stream with exactly one line to hide shows it instead. A failed command that printed something leads with `Exit code N`; one that printed nothing is only `Exit code N` (a timeout reads `Timed out`, a signal `Stopped before it finished`); a command that printed nothing and succeeded reads `(No output)`; a command whose non-zero exit is its answer (a `grep`/`rg`/`find` with no match, `diff` with a difference, `test` false, `git diff`, `git grep`; see [Tool execution](../sdk/tool-execution.md)) is drawn as a success, with the dot in the success colour, and when it printed nothing its note (`No matches found`, `Files differ`, `Condition is false`, `Some directories were inaccessible`) stands in dim where `(No output)` would be; one handed to a background job reads `Running in the background (↓ to manage)`, never the model-facing instructions. Binary output is named with its size. While the command runs the live region shows the same header and, once it reports output, the last 5 lines it reported (the kernel coalesces progress to the latest line, so these are the lines seen, not all of them), and under them one dim footer line that is there from the first moment, so no row appears later and nothing under it moves: `Running… · 3s` before any output, then the elapsed time, `limit 1m 30s` when the call set a `timeout`, `214 lines, 209 above` (the lines the command has printed, counted by the `bash` tool and sent as `outputLines` on `tool_progress`, and how many are not among the rows shown), and `ctrl+b to run in background` on the same line once the command can be moved (`ctrl+b ctrl+b (twice)` inside tmux). A stream longer than the kernel's window shows its gap as "… +80 lines", counted into the `+N`. Ctrl+O opens everything the host holds, which for a long stream is the kernel's first 80 and last 40 lines. A conversation saved before facts existed keeps the older reading, which strips ANSI, drops the credential note and the exit trailer and reads the status from the text. The retained raw output is untouched. A call the person answered No to reads "You declined this, so it did not run." with their words when they gave any, never the refusal text the model was given; a call to a tool that does not exist reads as one sentence. This cell is the row of a command that failed, was stopped, timed out, was declined or moved to the background, and of one that ran on its own; a command that ended well among others folds into the counted line under [Compact tool activity](#compact-tool-activity).
- **The permission, question and plan dialogs share one verb set.** `enter confirm`, `esc cancel` (it declines the batch and the agent carries on; in the plan dialog it keeps planning), `ctrl+c stop` (it also ends the reply), `y / n answer`, `d input` / `d script` / `d instructions` for the details toggle, and `←→ questions`, `space toggle` in the question dialog. The earlier `esc decline`, `esc skip`, `esc keep planning`, `enter choose`, `enter ok` and `ctrl+c stop the reply` are gone, so one key reads the same on every dialog. A duration under a second that a row does show (the workflow, web and agent lines) reads `420ms` rather than `0s`; a tool row says nothing for a call under a second; live counters keep whole seconds.
- **Key hints appear once per screen.** A picker or prompt draws its hint line inside its own box ("↑↓ select · enter apply · esc back"), and no footer is drawn while a box is open. The words are the same everywhere: `↑↓ select`, `enter apply`, `esc back` where the key returns to the previous screen, `esc cancel` where it drops what was being done, `esc close` for a viewer. A line wider than its room is one row at every width: each hint has a rank and, where it helps, a short form (`↑↓ or 1–9 select` becomes `↑↓ select`, `esc or ctrl+c exit` becomes `esc exit`, `k enter an API key` becomes `k API key`); the lowest-ranked hint is said short and then dropped (`PgUp/PgDn jump`, `Home/End`, `s provider setup`, `l create a Namzu sign-in` go first), a hint is never cut in the middle, and `↑↓ select`, `enter apply` and the key that leaves are the last to go. Every picker and dialog key line (the provider list and its sub-screens, the sign-in and key screens, the model, resume, copy and edit pickers, the text prompt, the effort slider, the permission prompt, the schedule and save-skill reviews, the agent cockpit, the slash and file menus) is built this way, and the provider list counts that one row in its height budget (a bordered box in the app's padded root has `columns - 6` columns of text, which `boxedHintWidth` in `key-hints.ts` gives; the slash menu's descriptions are held to two lines ending in `…`); the footer's own hint (for example "enter steer · tab queue · esc interrupt" while a reply runs) writes `enter` as `↵` before it drops a hint, and keeps the key that leaves. The folder trust screen has no footer at all: it names the folder and its keys once. `key-hints.ts` holds the vocabulary and the fitting.
- **A list that does not fit says so.** When the provider list is cut to the terminal's height it draws a quiet `↓ 3 more` under the last row it shows and `↑ 2 more` above the first, counted in rows; the lines come out of the height budget, so the box is still no taller than the screen, and the row under the cursor stays in view as it moves.
- **A startup that stopped on a file the person can fix** is the sentence alone, with no dot in front of it and no second block. "Startup stopped / Resolve the error above, then restart Namzu." appears only under an error that does not say what to do itself (a `ConfigLoadError` with `complete` set already ends with "Fix it, then start Namzu again."). The footer under a screen with no composer (this one, the pickers, the trust prompt) names the folder and any active mode but not `shift+tab to cycle`, which is the composer's key.
- **No Node warnings on screen.** `warning-filter.ts` is the first import of `bin.ts`. It drops Node's `ExperimentalWarning: SQLite is an experimental feature and might change at any time` (printed on Node 22 when the session index opens `node:sqlite`) and nothing else: the type and the sentence must both match, so every other warning still prints. `exec`, the scheduler and the desktop host start from the same `bin.ts`.
- **First run with no API key** says what the menu offers: "No API key found for OpenAI, your saved provider. Namzu looked for OPENAI_API_KEY and found none. Choose “Enter an API key” below, or pick another provider." A subscription sign-in row reads "uses a one-time code" or "opens your browser", not the protocol's name.
- **Argument errors** (`namzu --effort turbo`) read as sentences in sentence case ("“turbo” is not a valid value for --effort. Choose one of none, minimal, …"), wrapped at word boundaries to the terminal's width (at most 100 columns), then "Run namzu --help to see what is available." The exit code stays 64. `usage-error.ts` rewrites commander's one-line complaint.
- **After exit** the resume command is printed after a blank line, on a line of its own ("namzu resume <conversation id>"), so a narrow terminal soft-wraps one copyable line and the id never sits directly under the message box; `namzu resume` takes the whole id, not a prefix, and with no id opens the picker. A resume shows one closing row, "Resumed: <name or first prompt>", on every path: the picker, `/resume`, `namzu resume <id>` and `--continue`/`--resume`.
- **A settings file that cannot be read** is one sentence that names the file a person must fix, how they would write it, and where the parser stopped: "namzu.config.json in this project isn't valid JSON (line 3, column 5). Fix it, then start Namzu again." The user-level file reads as `~/.namzu/config.yaml isn't valid YAML (line 1, column 9)`, and the managed file by its path. A file whose top level is a list or a value rather than named settings is named the same way ("namzu.config.json in this project must be a set of named settings, not a list. Fix it, then start Namzu again."). The parser's own wording appears only with `--debug`. A file saved with a leading byte-order mark (Windows editors do this) loads as if the mark were absent, in the CLI, the scheduled-task digest and the desktop app's folder checks.
- **The provider list at narrow widths.** While the source column beside the name would be narrower than 24 columns (a terminal under 63 columns), each source is drawn on its own line under the name, indented to line up with it, and the name is not padded; at 63 columns and wider the source sits beside the name as before. The `← current` mark stays on the name's line when it fits and goes below the source when it does not. The row window counts exactly the lines drawn, in both layouts. The model list's count ("3/3") keeps a column between itself and the title, and a model row whose marks ("(current) (default)") would cut its name short draws them on the line under the name instead.
- **A model list that could not be fetched** is one sentence naming the provider and the next step ("OpenAI rejected the saved API key. Press Esc, then k to enter a new key.", "OpenAI is limiting requests right now. Wait a moment, then open the list again.", "OpenAI is having problems on its side. Try again in a minute.", "Namzu could not reach OpenAI. Check your internet connection, then try again."; for a server on this computer or network, "Namzu could not reach Ollama at localhost:11434. Start it, then try again.", and a list that did not answer in time names the provider: "OpenAI did not answer in time."), then "Showing namzu’s pick for it." The driver's own text follows "Details:" only with `--debug`, with its request ID labelled "Request ID:". A model switch or an effort check that fails says "Could not switch the model." (or the effort sentence) the same way, with the error text behind `--debug`. `modelListingCause` in `agent.ts` sorts the failure (401, 403, 429, 5xx, network, other) and `plainListingFailure` in `model-choices.ts` words it. A failure Namzu hit on its own at startup (the working folder, saved data, plugins, computer use, the browser, building the provider) is one sentence with a next step ("Namzu could not open the folder ~/x. It does not exist. Check the path, then try again.") and the error text behind `--debug`, labelled "Details:". The setup screen words how a credential was found as "Signed in with Codex", "Key from your computer’s settings" or "Saved API key", never the source's identifier. A key the provider rejects on the key-entry screen reads "<Provider> rejected that API key. Check it and try again." the same way.
- **Provider setup (`s`) never prints what a program printed.** The probe's output is read for a version number (`versionFromProbe` skips warnings) and the row says "Installed · version 0.46.0", "Not installed" or "Couldn’t check Codex. Details: --debug"; an install shows "Installing Codex… This can take a minute." and, if it fails, "Couldn’t install Codex. Details: --debug". The raw lines appear only with `--debug`. `setup-text.ts` holds the wording.
- **Folders in a sentence** are written with `~` for home, and when the line is short of room `displayPath` cuts the middle and keeps the first segment and the last folder whole ("~/…/packages/cli"). Every such path, the footer's included, is spelled with the platform's separator (`homePath` and `displayPath` are the one helper: `~\Work\clients\leaf-folder` on Windows, `~/Work/clients/leaf-folder` elsewhere). The folder trust prompt fits its path to the box's real content width (the terminal minus the app's inset, the border and the padding, `boxedContentWidth`), so the path draws one row from 40 columns up, its title and two sentences break evenly with no stray word on a line of its own ("files", "exit" alone), and the two choices share a row only when both fit.
- **The startup header and `/status` write the folder the same way**: from `~` or, when it does not fit, its last folders cut on a separator (`…/hygiene-live/run/proj`), never clipped from the left in the middle of a name. The bypass warning under the header and the bypass question printed before the screen opens wrap on words, with one constant indent on continuation rows, at the terminal's width.
- **The folder trust prompt says what the folder pre-approves** before the choice. It reads the folder's own `namzu.config.json` and `namzu.config.local.json` without applying them and lists the allow rules (`bash(git status *)`, at most eight, the rest counted), the extra directories the folder adds to the workspace, the tool servers its shared file would start and the hooks its two files declare (each as its event and what it would run, such as the command, `POST <address>` or the start of a prompt; at most eight, the rest counted, each line bounded), then one line saying they apply without asking. A folder whose config grants nothing shows nothing extra. The focus rests on the exit choice: `y` trusts, and `enter`, `n` or `esc` exits, so the answer the folder has to earn is never the default and a stray Enter can only leave. An Enter that arrives while the screen is still painting (the launch keystroke) is ignored, as `y` is. The detailed transcript hides the stale mode footer while open; clipping of long descriptions below about 90 columns is not addressed here.
- **The permission box names things once and keeps its words whole.** A write says what it does to the file (`New file · 3 lines` or `Replaces the existing file · 3 lines`; the title says `· new file` or `· may overwrite` to match) and the question does not repeat the file's name; several writes in one box name each file on its own row. The answers keep a hanging indent when one wraps, and the folder in "don't ask again for … in <folder>" is written from `~` or its last folders. An edit is drawn against the file as it is on disk when the box opens: the removed and added rows are the whole lines the replacement touches, and a line above them says when the text to replace is no longer in the file or now appears more than once. The review wraps on word boundaries (a word wider than a row is still cut so no character is ever hidden). On a workflow review, `d read the whole script` outranks `y / n answer` when the key line is short of room, because it is the only key that shows what will run.
- **The detailed transcript (`ctrl+o`) and the workflow detail replace the composer's mode footer** rather than drawing under it, so no stale footer row sits above them; both carry their own key line.
- **One gutter for every tool result.** A shell body, a one-line result and a web result all hang from the same `  ⎿  ` (two columns of indent, the glyph, two spaces), and a wrapped result lines up under its own text.
- **The stop-all chord's confirm is footer feedback, not a transcript row.** `Press ctrl+x ctrl+k again to stop background agents` (3 s) and `No background agents running` (2 s) replace the footer's hint and then disappear; only the stop itself leaves `● All background agents stopped`, and that is the only row it leaves: the stopped agents write no row of their own and the waiting line ends without a closing line. An agent stopped with Esc, Ctrl+C or the chord reads `was stopped by user` everywhere; one the conversation's own agent stopped reads `by Namzu`.
- **`/compact` leaves its echo and result where it ran**: on the default screen every row already printed stays above, then `› /compact`, then `✻ Compacted · N messages summarized. The messages above are summarized for the model (ctrl+o to see full summary)`, and the conversation goes on under it; nothing is erased and no row is printed twice. (Fullscreen redraws its own screen and keeps only the turns that stay.) `/context` leaves the `freeing about N tokens` clause out when the reclaimed size is unknown. Every resume path writes the `Resumed:` row with the same dot.
- **A launch receipt is written before the reply that follows the launch**, even when the reply arrives inside the receipt's 250 ms settle window.
- **`/workflows` and every choice list use a rounded frame**; below 70 columns a description wraps under its label (two lines at most) and a `·`-separated row drops whole trailing parts rather than cutting a number. The permission box labels its toggle `d view input`.
- **The model picker says the same thing at every width**: "Applies to this conversation and future launches." and the `(namzu default)` mark are cut by the row on a narrow terminal, never reworded.
- **A provider that cannot take something the conversation holds** is one sentence built from the event's fields, never from the kernel's text (`capability-notice.ts`): "Ollama can’t use tools, so Namzu will only chat while you use it. Switch to another provider to let Namzu work with files and commands.", "Ollama can’t see images, so it won’t see the picture you attached. Switch to a provider that reads images to include it.", the same for documents, and a "text note in place of a picture a tool returned" variant for tool results. The next step is always "Switch to another provider" (or "a provider that reads images/documents"), because the capability belongs to the provider driver, not the model. A history that was repaired before a reply says what happened in words, with no counts: when steps were left unfinished, "Your last reply was cut off before its steps finished, so Namzu marked them as unfinished. Check any files or commands they touched before asking again."; when only leftover duplicate or unmatched results were removed, "Namzu cleaned up some leftover steps from earlier in this conversation. Nothing you need to do." The counts show only under `--debug`. The provider is named by product name, never its id, and no tool count or label shows. The kernel's own wording follows only under `--debug`, and an exported transcript uses the same sentences (a provider switch reads "Anthropic was too busy, so Namzu used OpenAI for the rest of that reply.", with no ids or reason codes).
- **Setup and picker wording** is plain: the setup intro says the other coding apps are optional and that Namzu can reuse their sign-ins, a missing sign-in reads "Not signed in for Namzu" followed by the login command, "Zen free models · experimental, and Zen may refuse them", "1 found · sign-ins, API keys and local servers". Zen’s free models are experimental and Zen may refuse them, so the Zen rows and notices say that and point at a Zen API key as the next step. Text that can wrap is broken by `wrapBalancedText`, not by the renderer (which starts a continuation with the space it broke at), so no wrapped line starts indented and none is one stray word. Each line wraps inside 40 to 80 columns (`plain-setup-wording-at-narrow-widths.test.tsx`, `plain-provider-list-wording-at-narrow-widths.test.tsx`).
- **Typographic apostrophes**: person-facing text uses ’ ("couldn’t", "Namzu’s"), never inside code, flags, paths or JSON.
- **Launch flags**: `--provider` with a name Namzu does not know says so above the picker; `--model` with a name the provider does not list warns once the session starts; `/model` with a name it cannot find reads "No model called ... is available to you, so the model was not changed." and leaves only that line in the transcript.
- **One glossary** (`person-terms.ts`) names the concepts: "reply" where the kernel says turn, "conversation" for session, "summarising the conversation" for compaction, "on this computer" for host. Sizes are `1.2 MB`, spans `20s`, counts are pluralised.

## The terminal title

The terminal's own title (the tab or window name) says what the conversation is. It is set with
OSC 0, which sets the window title and the icon name, ended by BEL:

- **What it says:** a glyph, a space, then the name. The name is the one a person
  gave the conversation with `/rename`; else the title the
  [small model](small-model.md#conversation-titles) wrote; else `Namzu`. It is
  shown on one line (control characters and line breaks are removed) and cut at
  100 characters.
- **The glyph** is `✳` while the interface waits for input and while it waits
  for a permission answer. While a turn is working it alternates `◐` and `◑`
  every 960 ms. The animation runs only while the terminal has focus (see
  [Focus and the away recap](#focus-and-the-away-recap)); a window that reported
  losing focus keeps the frame it was on. Under a terminal multiplexer (`TMUX`,
  `STY` or `ZELLIJ` in the environment) the glyph does not move and a working turn
  shows `✳`, because the multiplexer would redraw its tab on every change. The
  title is written only when its text changes.
- **When it is written:** when the interface opens, when the name or the
  generated title changes (`/rename`, the first message's title, `/resume`, a new
  conversation), and when a turn starts or ends.
- **On exit** it is reset with an empty OSC 0 (`ESC ] 0 ; BEL`), including when
  the process exits abnormally, so the shell's own title comes back.
- **Off:** `NAMZU_DISABLE_TERMINAL_TITLE=1`. Nothing is written to a stream that is
  not a terminal.

## Focus and the away recap

**Focus reporting.** While the interface holds the keyboard it asks the terminal to report focus
(`ESC [ ? 1004 h`) and turns that off when it lets go, including while an external editor runs and
at exit (`ESC [ ? 1004 l`). The terminal answers with `ESC [ I` (gained) and `ESC [ O` (lost). The
reports are taken off the input stream before it is read (`focus-reporting.ts`), so they are never
typed into the composer. Nothing is written to a stream that is not a terminal. A terminal that
never reports leaves focus *unknown*, which counts as focused: only an explicit loss of focus ever
makes Namzu behave as if you are away, and a key pressed after one proves you are back. Focus
drives the title animation above and the recap below.

**The recap.** A conversation that has been left alone gets one line saying where things stand,
written by the [small model](small-model.md#the-away-recap), shown when you come back:

```text
※ recap: Adding retries to the upload client; tests pass. Next: wire the config flag. (disable recaps in /config)
```

- **When it starts.** Only from a loss of focus the terminal reported. It is written three minutes
  after a reply ended, and no sooner than two seconds after the window lost focus. If the window is
  still unfocused then, the rules below are checked and the request is made.
- **When it does not.** The recap is off; a reply is running; the composer holds a draft; a
  background agent or workflow is running; a session loop is scheduled; the conversation has fewer
  than three typed prompts, or fewer than two since the last recap; its last row is already a
  recap; or three attempts in the current reply have failed. A failed attempt shows nothing.
- **Coming back cancels it.** Regaining focus, or a new reply starting, stops the countdown and
  drops a recap still being written. A conversation switch (`/new`, `/resume`, `/clear`) forgets
  the old countdown.
- **What it looks like.** A row in the conversation, not an overlay: `※`, a bold `recap:` and the
  text, all muted and the text in italics, one blank row above. The first three recaps of a launch
  end with ` (disable recaps in /config)`. It is a display row only: it is not sent to the model,
  not counted as something you typed, and not part of an export. `/raw` shows `recap: <text>`.
- **The text.** Under 40 words, one or two plain sentences, no markdown: the overall goal and what
  is being worked on, then the one next action. Longer than 400 characters it is cut at a word and
  ends with `…`.
- **Off.** `tui.recap: false` in a config file, `/config recap off` (writes that to your user
  config; `/config recap on` removes it) or the **Session recap** row in `/config`. `NAMZU_RECAP`
  overrides the setting: `0`, `false`, `no`, `off` turn it off and `1`, `true`, `yes`, `on` turn it
  on. Runs without a screen (`namzu exec`, `--json`) never recap. `NAMZU_RECAP_WAIT_MS` replaces the
  three-minute wait with a number of milliseconds, so the recap can be tried without waiting.
- **`/recap`** writes one now, whatever the setting, focus, draft or background work. The answer is
  an ordinary notice without the `※` row or the hint. With no reply yet it says "Nothing to
  recap yet — send a message first."; if it is stopped, "Recap cancelled."; if the small model
  could not answer, "Couldn't generate a recap. Run with --debug for details." It refuses when a
  loop you scheduled sent the line rather than you typing it.
- **Cost.** One small-model request per recap (120 reply tokens at most, a digest of at most 6,000
  characters), charged to the latest reply. Recaps need at least two new prompts to repeat.

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

### How the default screen is painted

The default screen prints each finished row once into the terminal's scrollback and keeps a small live region
at the bottom. Fullscreen has its own renderer and is not described here. The live region is written by a
writer of Namzu's own (`packages/cli/src/tui/paint/`) that sits between the renderer and the terminal:

- **Only what changed is written.** A frame is compared with what is on screen row by row, and inside a changed
  row cell by cell, so a label whose colour moves one letter along costs a cursor move and that letter. A frame
  equal to the one on screen writes nothing, not even the synchronized-output marks. Rows that finish and go to
  scrollback are printed above the region and the region is drawn once under them. A paint that carries such
  rows writes over the old rows from the top, each line clearing only its own row's remainder, and when it has
  more lines than the region had rows it writes the extra ones first, under the region, so a terminal that
  ignores synchronized output never shows a blank bottom, only old and new rows mixed for a moment. The marks that let a terminal
  show a frame whole (`?2026`) are kept, and the screen is right on a terminal that ignores them.
- **At most twelve paints a second.** The first change after a quiet moment is painted at once; changes that
  follow within 83 ms are folded into the next paint, so a flood of shell output or reasoning text is one paint
  per interval, the last state is never dropped, and rows meant for scrollback are kept in order. A reply that is
  written (see [A reply as it is written](#a-reply-as-it-is-written)) hands the writer the blocks it has finished
  many times in one turn; each paint carries those that finished since the last one, once and in order, and the
  region under them keeps the same shape. The reply's own release of new words (about every 80 ms) and this budget
  are one rhythm, not two in a row: from the model sending a piece of text to its words standing on screen takes
  0.13 s at the median and 0.2 s at the 90th percentile, and the last words of a reply are on screen within 0.1 s
  of arriving. The clock on
  the working line still moves every second.
- **Nothing the terminal already holds is erased.** The terminal UI begins at the start of a line under what was on
  screen (if a program left the cursor in the middle of a line, a reversed `%` ends that line, as shells do).
  What was on screen and everything in the scrollback stay, and the banner is drawn under them. (Before, launch
  cleared the screen and the scrollback.) The same rule holds for the rest of the session: text printed before
  launch and the conversation rows already printed are never erased and never printed a second time, by a resize,
  a compaction or a clear. `/compact` (and the idle compaction) prints one row under what is there and goes on.
  `/clear`, `/new`, `/resume` and a theme change ask for a new screen: the visible screen is cleared, but the rows
  on it first move up into the scrollback, and the "erase saved lines" sequence is never written. The rows
  still in the live region at that moment (the last few finished rows of the conversation, not yet printed) are
  kept by `/clear` and Ctrl+L: they are printed first, through the path every other row takes, the terminal is
  given them, and only then is the screen cleared, so everything that was on the screen is in the scrollback
  afterwards, once and in order, and the input box and what hangs on it are not copied. `/resume` and a theme
  change still clear without that step, so the rows in the live region at that moment go with the screen. The
  old painting (`NAMZU_LEGACY_PAINT=1`), the zoomed workspaces screen and the fullscreen view are as before. Rewinding to summarize part
  of the conversation rewrites rows that were printed, so it prints the conversation again under the old rows.
  Fullscreen owns its alternate screen and is not covered by this rule.
- **A resize never touches scrollback.** Rows already printed stay as the terminal reflowed them and are not
  printed again. The terminal UI waits until the size has stopped changing (150 ms without a new event, so a drag
  is one redraw), tells the renderer once, waits 100 ms for the frame at the new width, erases only the live
  region (as many rows as the terminal made of it at the new width) and draws one frame. No frame is drawn at the
  old width. Printed rows keep the line breaks the terminal gave them: after a narrowing resize, rows already printed are
  wrapped by the terminal and can break in the middle of a word (every row is still there, once, in order); it
  is the price of never rewriting the scrollback, and widening again does not undo it. A region taller than the terminal's new height (a long reply being written, with its plan under it, in a window that
  became shorter) has its top rows pushed into scrollback by the terminal before Namzu could erase them; those rows
  stay where they are, and when they are exactly the rows about to be written again (the part of the reply that was
  live, and the rows printed from it since) they are not written a second time.
- **A conversation replaced in place is passed through, then drawn under.** `/resume`, `/clear` and `/new` have
  the renderer clear the terminal and write the conversation again. That block is written as it came, except that
  the rows on the screen are pushed up into the scrollback first and only the screen is cleared (the sequence that
  erases the scrollback is never written); the height of the frame it ends with is taken from the next frame's
  erase, and painting by what changed goes on from there. (Before this, such a block left the screen empty.) A
  compaction is not one of these on the default screen: it keeps the rows and adds one.
- **Where the input box rests when a turn ends.** The working line, the plan, the calls and the live end of the
  reply leave the region when a turn ends, so it is shorter. By default the box rests where the shorter region
  ends: right under the last reply, with the rows the working area had left empty under the status line until
  the next turn starts (3 rows after a short reply at 80x24). `NAMZU_BOX_AT_BOTTOM=1` in the environment keeps
  the box on its row instead. With it the renderer is told the turn has ended (before the
  frame that drops those rows is drawn) and for that one shrink, when the rows that went were above the box (the
  rows left are the old frame's last rows, the status line aside), the region keeps its height: the freed rows
  become blank rows just above the box and the box and the status line stay on the rows they had while the turn ran.
  So a reply that ends with the screen full leaves the box on the last rows, 120x40 and 80x24, for a short reply, a
  folded group, an interrupted turn, a plan and a long reply alike. Frames of the same height change their rows in
  place; the next turn's working line and calls fill the blank rows first, so nothing scrolls for them and no blank
  row reaches the scrollback; rows printed meanwhile go above the region. A frame that is taller than the kept
  height, a different shape (a menu opening or closing under the box), a resize, a clear or a screen that is not the
  default one lets the height go. While a reply streams, its live rows leaving the region as they are printed
  never pin it (no turn has ended). The cost is the blank rows themselves: between the last row of a short reply
  and the box there are as many blank rows as the working area had (3 after a short reply at 80x24, up to 5
  after a plan), until the next turn starts, which is why it is not the default. `NAMZU_LEGACY_PAINT=1`, which
  hands the writing back to Ink, never keeps the height.
- **Leaving gives the terminal back.** The last frame is painted, the cursor is shown and left at the start of a
  line under the last frame, also after a signal (Ctrl+C twice, `SIGTERM`, `SIGHUP`) and when the process ends
  without unmounting (an uncaught error). A process continued after a stop draws a fresh frame on a new line
  below whatever the shell printed; the earlier frame stays where it was above the shell's lines, so the last
  rows of the live region can appear twice in the scrollback (erasing it would erase the shell's lines).

`NAMZU_LEGACY_PAINT=1` hands the writing back to the renderer, which erases and writes the whole live region on
every frame and clears the terminal on a resize as before. It is a way back for a terminal the writer does not
suit, not a setting to keep.

Measured with a pseudo-terminal, colour on, a scripted model on loopback, ten seconds from the start of each
moment (four for the shell command, eight for thinking); "erase" counts the sequences that erase a row or the
region (`ESC[2K`, `ESC[J`); there is no full clear of the screen or scrollback in any of them, before or after:

| Moment | Size | Before: bytes, paints/s, erases | After: bytes, paints/s, erases |
|---|---|---|---|
| A streaming reply | 120x40 | 244 KB, 15, 3387 | 18 KB, 11.7, 1 |
| A streaming reply | 80x24 | 192 KB, 15, 2911 | 18 KB, 11.7, 0 |
| The model thinking | 120x40 | 218 KB, 31, 2509 | 16 KB, 12, 0 |
| The model thinking | 80x24 | 176 KB, 31, 2469 | 12 KB, 12, 0 |
| A shell command flooding output | 120x40 | 284 KB, 57, 3712 | 10 KB, 12, 0 |
| A shell command flooding output | 80x24 | 259 KB, 57, 3743 | 10 KB, 12, 0 |
| A silent wait (the label's animation only) | 120x40 | 60 KB, 8.5, 762 | 5 KB, 8.5, 0 |
| A silent wait (the label's animation only) | 80x24 | 50 KB, 8.5, 762 | 6 KB, 8.9, 0 |
| A fast reply (three seconds, gathered into few paints) | 120x40 | 156 KB, 20, 2071 | 45 KB, 6.7, 2 |
| A fast reply (three seconds, gathered into few paints) | 80x24 | 97 KB, 20, 1294 | 31 KB, 6.7, 2 |
| A silent wait, thirty seconds | 120x40 | 135 KB, 6.3, 1695 | 14 KB, 6.3, 0 |
| A silent wait, thirty seconds | 80x24 | 113 KB, 6.3, 1695 | 14 KB, 6.3, 0 |
| Idle | both | 0 | 0 |

When one paint prints more rows than the terminal is tall (a reply that arrives all at once), the bottom of the
screen is a mix of old and new rows until that paint ends; a terminal that supports synchronized output shows
none of it. A silent wait still paints about eight times a second because the label's colour moves every 120 ms, but each paint is
a few dozen bytes (median 33). A resize from 120x40 to 80x24 mid-reply wrote 65 KB with one clear of screen and
scrollback and 973 erased rows before, and 6 KB with no clear and one erase after; a burst of three more resizes
gave two clears (85 KB) before and one erase (6 KB) after.

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

## Terminal notifications

Off by default. `tui.notifications` in a config file turns on notices written to the terminal itself (`packages/cli/src/integrations/notifications/terminal.ts`): `true` means `turn-settled` (a reply ended) and `approval-required`; a list names the events wanted, and `[]` switches all off. A third event, `idle-prompt`, is asked for by name and is not part of `true`: it says "waiting for your input" once, a minute after a turn ended, and only if nobody has pressed a key since, no permission prompt or picker is open, nothing queued or looping will start a turn by itself, and that turn's end was not announced already. Background agents, shells or workflows still running hold the notice until they finish, then it counts again (`idle.ts`; 60 000 ms). The `approval-required` notice (and the `approval_required` notification hook) goes out only when the dialog has been open for 6 s with no key pressed since it opened, retried until the person has been quiet that long, and not at all when it is answered first (`approval.ts`), so someone at the screen is never pinged. Nothing in a notice carries conversation text.

`tui.notificationMethod` picks the escape sequence: `osc9` (the default; iTerm2's form, `Namzu: <text>`), `kitty` (OSC 99 in three writes: title, body, focus request), `ghostty` (OSC 777 `notify`) or `bel`. There is no automatic choice from `TERM_PROGRAM` and no iTerm2-with-bell variant; none of these is acknowledged by the terminal, so "sent" means written, not shown. The sequences end in BEL.

### The turn chime

On by default, and separate from the notices above: it needs no `tui.notifications` and is not part of `true`. When a turn that ran for ten seconds or more finishes, a soft rising pair of notes plays; when a turn stops, fails or waits for approval, a double tap plays. A shorter finished turn is silent, because the person was watching it, and so is the `idle-prompt` reminder. The approval sound goes out with the approval notice, after its 6 s of quiet. Two sounds within 1.5 s are one. Both sounds are synthesised in code (`integrations/notifications/sound/chime.ts`), written once as WAV files to `<NAMZU_HOME>/cache/sound/`, and played by the first program that exists: PowerShell's `SoundPlayer` on Windows and, through interop, on WSL; `afplay` on macOS; `paplay`, `pw-play` or `aplay` on Linux. The sound plays on the machine Namzu runs on, so it is silent over SSH, and a missing player leaves everything as it was. `tui.sound: false` or `NAMZU_NO_SOUND=1` turns it off (`sound.ts`).

## Paste and response boundaries

The composer enables terminal bracketed paste while it owns input. A paste split
across terminal input chunks is assembled before editing the draft; pasted
newlines do not submit it. Windows CRLF and CR line endings become LF. A paste
longer than 800 characters, or with more than `min(rows - 10, 2)` line breaks,
becomes a chip inside the input text: `[Pasted text #N +M lines]` (`[Pasted text
#N]` when it has no line break). A pasted image is `[Image #N]` ([how images are read](clipboard-and-images.md)); N is the image's number for the whole conversation, fixed when it is attached and continued after a resume, and an image whose marker leaves the text by any route is no longer attached. Image, document and pasted-text markers are each one unit in the composer: the cursor never rests inside one, Left and Right step over it, and every edit (Backspace, Delete, word and line kills, undo) takes all of it or none; the marker is drawn in the theme's system-text colour. Text that looks like a marker with nothing behind it is ordinary text. A pasted-text marker is replaced by the text it stands for when
the message is sent, so history recall and draft restore see the full text; an image or document marker stays in the sent words, and one quiet row under the sent message per attachment names its marker, file name and size, as a link to a copy on disk where the terminal takes hyperlinks. The sent message is echoed in the conversation with that text in full, pasted lines included; only a message over 10,000 characters is cut, to its first and last 2,500 characters with a dim divider between them that reads `(N lines, ~M KB hidden)`. The model always receives the whole message. Other
pastes insert at the cursor as typed text. There is no separate chip row. Terminals without bracketed-paste support retain chunk-based fallback
handling, which cannot reconstruct a paste boundary the terminal does not send.

A paste marker (`ESC [ 2 0 0 ~` before the paste, `ESC [ 2 0 1 ~` after it) that
the terminal's bytes split across two reads is kept whole even when the second
read comes late (`tui/paste-marker-guard.ts`). The input library flushes an
unfinished escape sequence as typed text after 20 ms, which on a slow or lossy
link put the rest of the marker (`[200~`, `[201~`) into the message box. The
stream the library reads is wrapped, and a read that ends with a proper prefix
of a marker, `ESC [` or longer, is held back until the next read joins it or a
bound passes. The bound depends on what the prefix can still be.
`ESC [` is the Alt+[ key on its own (nothing is bound to it by default), and `ESC [ 2`
begins Insert (`ESC [ 2 ~`), F9 (`ESC [ 2 0 ~`), F10 (`ESC [ 2 1 ~`) and the other
`2x~` function keys, with their modified forms (`ESC [ 2 0 ; 5 ~` is Ctrl+F9). A
terminal writes each of those whole, so a pause inside one is a slow link; these two
prefixes wait up to 200 ms. `ESC [ 2 0` is shared with F9, but it is also the split
the marker suffers, so it waits up to 2 s, as do `ESC [ 2 0 0` and `ESC [ 2 0 1`,
which begin nothing but a marker. The price is that a split F9 can arrive up to 2 s
late; a whole F9 is not a prefix of anything and is not delayed. Every wait ends at
its bound, so a terminal that died mid-marker cannot hold keys back for good: the
bytes then go on unchanged and the library treats them as it always did. What this
changes for a key: Alt+[ (`ESC [` alone) now reaches the library up to 200 ms later than it used
to (its own 20 ms follows), and a function key split by the link is joined
instead of being typed as text. A complete key (an arrow, Alt with a letter, Insert,
a function key, a focus or mouse report) is not a prefix of anything and passes at
once. A lone `ESC` is never held: it is
the Escape key and is recognised on the library's own 20 ms schedule. A link
that splits a marker right after its `ESC` and then pauses sends the same
bytes as a person pressing Escape and typing `[200~`, so that one split is not
repaired.

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

## Tips and the next task under the working row

While a reply runs, one dim line sits under the `Working` row.

- **`Next: <task>`** when the model's plan has a pending task: the first pending task whose blockers are all finished, else the first pending one. It is one row, cut with an ellipsis at the terminal's width. It is not a tip and shows whatever the tips setting says.
- **`Tip: <text>`** otherwise, a short pointer to a Namzu command or setting you have not used yet. It is chosen once, when a reply ends, and stays the same for the whole next reply, so a launch's first reply shows none. Each tip has a cooldown counted in launches (terminal starts), not turns, kept in `~/.namzu/tip-history.json` with how often each command has run; the tip that has gone unshown the longest wins, then its priority, then its place in the list. A tip appears only while its condition holds (for example `/goal` until you have used it, or the status line while none is set).
- Both rows give way to the retry notice and to the `Compacting conversation…` row, and the compact layout on a very short terminal leaves them out.

Turn tips off with `tui.spinnerTips: false` in `~/.namzu/config.yaml`, with `/config tips off` (or the **Tips** row of `/config`), and back on with `/config tips on`. Only an explicit `false` turns them off. Only the interactive terminal shows tips; `exec`, `drain`, ACP and scheduled runs never do.

## Task continuity in the CLI prompt

The CLI identity describes Namzu as an AI kernel with a TypeScript SDK and
the CLI as one interface. Completed prior-turn tool actions remain usable
evidence; the identity does not require a fresh action just to report earlier
work. It still forbids invented actions and distinguishes current execution
from history. An unavailable capability blocks dependent work, not unrelated
parts that can still be completed. Shared coding guidance uses proportional
verification and defers concurrency guarantees to runtime metadata.


### The detailed transcript (Ctrl+O)

Ctrl+O replaces the composer, status row and activity line with the conversation drawn in full, and
Ctrl+O, Esc, `q` or Ctrl+C returns to the composer with the draft as it was. Nothing is written to
scrollback by opening or closing it, so a settled row is never reprinted: the screen is a box in the
live region (never the alternate screen) as tall as the terminal less a footer.

Ctrl+O always shows the conversation you are in (the parent one), because that is the only place a
`(ctrl+o to expand)` hint is drawn. It does nothing while the PageUp scroll view is open (leave that
first with End or Esc), and in the agents cockpit or a child agent's own transcript, which draw
their own rows and carry no such hint.

- Every row is drawn expanded: tool bodies and shell output whole, a command whole, a diff whole, an
  agent's answer whole, a compaction's counts and summary. A counted line of reads and searches, open
  or settled, shows each of its calls with its result, and a call that failed shows its error in the
  error colour. No `(ctrl+o to expand)` hint is drawn on it, because every hint elsewhere points here:
  a folded result, an error body past ten lines, a shortened line, a diff past its fold, a shell
  output, a counted line, an agent's answer, a compaction, a web result and a conversation lookup each
  show their hidden part here.
- While a reply streams and the screen is open, nothing under it is rewritten: an idle compaction
  waits, and a `/context` read afterwards sizes the conversation from its messages when a compaction
  has made the last reported size stale.
- The model's thinking is kept on the row that followed it and drawn only here, dim italic under the
  mark `∵` (the assistant mark stays `∴`). It is not saved with the conversation, so a resumed or
  forked conversation shows none.
- Only the last 30 rows show. When older ones exist the first row reads `ctrl+e to show N previous
  messages` (N bold); Ctrl+E shows all of them and the row reads `ctrl+e to hide N previous
  messages`.
- The newest row is at the bottom and the screen keeps following the reply that is streaming. `↑`/`↓`,
  `j`/`k`, `PgUp`/`PgDn`, space, `b`, `Ctrl+U`/`Ctrl+D`, `Ctrl+F`/`Ctrl+B`, `g`/`G` and Home/End move
  through what is taller than the terminal.
- The footer is one dim row under a rule: `Showing detailed transcript · ctrl+o to toggle · ctrl+e to
  show all` (`to collapse` after Ctrl+E), `verbose` at the right edge. A permission request, plan,
  question or review that arrives behind the screen is not drawn over it: the footer starts with
  `dialog waiting · ` in the warning colour, and the request appears when the screen closes.
- It does not build search, previous/next prompt, the print-to-scrollback or open-in-editor keys, or a
  help panel.

The PageUp scroll view from the composer is a separate feature and is unchanged. The per-row
expansion and the tool-output viewer no longer exist. This changes only presentation, not model
history or tool execution. Existing static scrollback is not erased.

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
