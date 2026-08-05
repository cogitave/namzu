---
'@namzu/cli': minor
---

`--permission-mode` decides what happens to the calls no rule covered

The `[permissions]` table says what a tool may do. This says what happens to
everything it did not cover: `prompt` asks, `auto` approves, `strict` refuses.

`strict` is the one that did not exist. An unattended run could only be `auto`,
so a CI job either trusted the agent with every tool it might reach for or could
not use it. Under `strict` nothing runs unless a rule allowed it by name or
pattern, and the refusal tells the model that asking again will not help — so it
stops rather than rewording.

`--yolo` and `--dangerously-skip-permissions` now mean `--permission-mode auto`.
They were accepted and documented as doing nothing, which was true and
unsatisfying.

**Precedence, stated once:** a mode only governs calls no rule decided, so it can
never reopen what a rule closed. `--permission-mode auto` cannot run something
the config says `deny`, and neither can `--yolo`; the dangerous-pattern floor is
above both. The config file is written once and reviewed; a flag is typed in a
hurry. A prohibition a flag can lift is not a prohibition.
