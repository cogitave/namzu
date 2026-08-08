---
'@namzu/cli': patch
---

`/permissions` reports the approval posture actually in force

The page whose whole job is to answer "how do tool calls get approved here" gave
two answers that were not true.

**It could not see "approve all".** Pressing `a` at a prompt sets a latch that
approves every later tool batch for the rest of the session. That latch lived
inside the agent session's closure and nothing exposed it, so `/permissions`
reported the posture from your flags alone and kept printing *"Unreviewed calls:
you are asked before they run"* after you had turned exactly that off. One
keystroke inverted a security posture and the surface that exists to report it
could not know. It now reports approve-all as automatic approval, says how to
get back to being asked, and reads the latch when it renders rather than
inferring it.

**It never mentioned that some tools are never prompted for.** `read`, `glob`,
`grep`, `ls`, and the memory and task tools run without asking, always. That is
deliberate and defensible, but it is undiscoverable by using namzu — the calls
simply never appear, so their absence reads as "the agent did not use any". The
readout now names the set, taken from the same list the gate consults so the two
cannot drift, and states the two limits honestly: a rule can still deny one, and
anything flagged destructive is prompted for even if it is on the list.

Two smaller corrections on the same page:

- **Rules are described instead of named.** `describeRule` handled two of the
  eight rule types and printed the bare type name for the rest. A `permissions`
  table compiles every per-pattern entry to `custom_pattern`, so the commonest
  real config — `"git push*" = "deny"` — was reported to its author as the
  single word `custom_pattern`. All eight are spelled out now, with a `never`
  guard so a ninth fails the build rather than printing itself. A compiled
  pattern is shown as the regex it compiled to, which is not what you typed;
  that is the form that actually decides, and inventing a prettier one would be
  reporting a rule that is not in force.
- **It pointed at TOML syntax for a JSON file**, telling you to add a
  `[permissions]` table to `namzu.config.json`.

No public API changes; `SlashContext` is internal to the CLI.
