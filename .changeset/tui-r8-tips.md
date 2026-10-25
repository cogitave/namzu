---
'@namzu/cli': minor
---

While a reply runs, the terminal now shows one dim line under the `Working` row: `Next: <task>` when the model's plan has a pending task, otherwise a short `Tip:` about a command or setting you have not used. A tip is picked when a reply ends, holds for the next reply, and does not return until its cooldown (counted in terminal launches) has passed; the history is kept in `~/.namzu/tip-history.json`. To turn tips off set `tui.spinnerTips: false` in `~/.namzu/config.yaml` or run `/config tips off`; the `Next:` row is not affected. Nothing you call from code changes.
