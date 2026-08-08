---
'@namzu/cli': major
---

Enter no longer grants folder trust

**Press `y` to trust a folder.** `Enter` now grants nothing at the trust gate.
If you accept by reflex with `Enter`, that reflex has to change.

This is the same defect as "Enter no longer approves a tool-permission prompt"
in the previous release, at the screen before it — and the pair is worth reading
as a class rather than as two incidents. Both screens asked the operator to
permit something, both accepted the key people press to dismiss whatever just
appeared, and neither named that key anywhere on itself. The first one looked
like a slip. The second says it was a habit, so the rule is now written down
once, in `consent-timing.ts`, where the next screen of this kind will inherit it.

The trust gate is the sharper of the two:

- **The keystroke is near-certain, not merely possible.** You reach this screen
  by typing `namzu` and pressing Enter. A key repeat, a buffered second press,
  or an impatient double-tap arrives while the gate is still painting — the one
  moment in the program where an in-flight Enter should be expected.
- **The decision is durable.** Approving a tool call runs one tool. Accepting
  here writes the folder into `~/.namzu/trust.json`, which covers every
  subfolder, so a stray keystroke grants standing permission to a whole tree.

What changes:

- **`y` grants trust; `Enter` does nothing.**
- **`y` is ignored for 350ms after the gate appears**, so a keystroke aimed at
  the shell behind it cannot land on it.
- **Refusal is never deferred.** `n`, `Esc` and `Ctrl+C` exit on the first
  press. Nothing has been written and nothing has run, so an accidental refusal
  costs a relaunch — the recoverable direction — and a hesitating escape hatch
  on the program's first screen would read as a hang.
- **`Esc` is now advertised.** It always exited; it said so nowhere.

`permission-timing.ts` is renamed `consent-timing.ts`, since it now governs both
consent screens. It is internal to the CLI and not part of the published API.
