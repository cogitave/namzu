---
"@namzu/cli": minor
---

The composer footer now sits directly under the message frame in every case, and the automatic agent rail — the panel that used to be titled "Delegated work" — no longer uses that literal title.

Before: the render order below the message frame was frame → delegated-work rail (when agents were live) → footer, so the footer's row depended on whether a rail was drawn between it and the frame. The rail's title, and the agent cockpit's per-workflow header, fell back to the literal string `Delegated work` whenever no single explicit `workflow` label covered every agent shown — including the ordinary case of agents that never set one.

Now: the order below the frame is frame → footer → the rail (or, in its place, the agent cockpit, a child transcript, or the tool-output viewer). The footer is always the row immediately after the message frame's bottom border, whether or not anything follows it. The rail's title is the workflow label every one of its agents shares; when they carry none, or carry more than one, the title is a neutral count instead — `2 agents · 1 running` — never the generic "Delegated work" name. The agent cockpit's header follows the same rule. Each row of the cockpit's own workflow picker (`ctrl+t` with two or more groups live or retained) follows it too: an unlabelled group is named after its own lead agent instead, so two unlabelled groups no longer render as identical "Delegated work" rows. The right-hand side of the rail is unchanged (`N active · M total · ↓ / ctrl+t`).

Nothing about permission-mode behavior, the footer's own content rules, or agent scheduling changed — only where the rail draws relative to the footer, and what its title says when no workflow was named. Minor, not patch: an operator with agents running sees a different screen layout, and any workflow that never sets an explicit label now reads a different title in the rail and the cockpit — a terminal-automation script or screenshot keyed to either no longer matches.
