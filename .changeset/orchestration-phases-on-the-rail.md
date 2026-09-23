---
"@namzu/cli": minor
---

Delegated work split into phases reads by phase, as the reference terminal's workflow view does. Nothing is removed and no key changes meaning; screens and transcripts look different.

- **The agent rail keeps a phased workflow together.** Agents sharing a `workflow` label stay on the rail as one piece for the parent turn: a finished phase is one line, `✓ Phase 1 · 2/2 · 4.0s`, and a live phase has its agents beneath it. Unlabelled agents are grouped by launch, as before. Under 24 rows a finished phase's line is left out.
- **The rail's header counts the whole workflow**: `● <workflow> · 1 running · 2/3 done · 6.5s · 18.0k tokens · ↓ / ctrl+t`. Time and spend show from 96 columns.
- **The agent cockpit opens on the phase still working**, and on its first working agent, instead of on the first phase. Its header reads `2/3 agents done · 1 running · 7.7s · 18.0k tokens` while work runs and `3/3 agents · 9.5s · 27.0k tokens · done` after, in place of `N active · N total`. Phase rows add the phase's time; the agent pane is titled by its phase (`Phase 2 · 1 agent`) instead of `Agents · 1/2`.
- **The closing line** adds the phase count when two or more were named, the tokens spent, and failures: `✻ Worked for 11s · 3 agents in 2 phases · 27.0k tokens`.
