---
"@namzu/cli": minor
---

The parent can now write a line of commentary above the agent rail, through a
new `narrate_work` tool.

While several agents are running, the rail says what each one is doing but
nothing says why — which phase just came back, what disagreed, what happens
next. `narrate_work` takes one `line` and shows it directly above the rail,
outside its border, in the run's own voice. It changes nothing: no task is
started, corrected, stopped or re-ordered, and no surface reads the line back.

Bounded on purpose, because the rows it spends are the most valuable on the
screen: the three most recent lines stay, a further line drops the oldest, each
line is one row clipped at 200 characters with a marker saying so, a blank line
is refused, and the whole band is cleared when the conversation is reset. Text
longer than twice a row is not a line and is refused rather than reduced to its
opening clause. A session that never calls it renders exactly as it did before
— no heading, no separator, no reserved row — and the band never costs the
agent rail a row: the rail's height budget is computed from the terminal's own
rows, and on a full screen the band's rows are paid for by the conversation
scrolling at the top, the way every row this interface adds is paid for.

The call is not reviewed: it declares itself read-only because it starts,
changes and stops nothing — no file of its own, no request, no task — and a
consent dialog per line of commentary, shown to the operator being asked, is a
tool nobody would call. `send_message` and `cancel_agent`, which do reach into a
running child, are reviewed exactly as before. A successful call adds no
transcript row either — the line is already on screen — while a refused one
keeps its row, since nothing was shown.

The tool is mounted only in the interactive terminal, where somebody is there
to read the line — the same condition `ask_user_question` is mounted under.
`namzu run`, `namzu run --stream`, `namzu drain` and the resident step have no
rail for a line to appear above and are not offered it, so their tool rosters
are unchanged by this release.

The tool is the parent's alone. It is registered on the parent conversation's
registry beside `send_message` and `cancel_agent`, and a delegated child's
roster carries none of them, so nothing a child writes can be rendered as the
run's own narration. A child's output stays wrapped as untrusted, which is the
whole reason the boundary is where it is.

The band is in-memory only: it is cleared on reset and nothing replays it onto
the screen after a resume. The call is not. It is recorded in the run's
transcript and in the conversation's checkpoints like every other tool call,
and it returns to the model's own history on `/resume` — so treat a narrated
line as durable text about the work, not as a caption that disappears with the
screen.

Additive: a new tool on the roster the parent already carries, and an optional
narration reader on the session's activity source. Nothing existing changed.
