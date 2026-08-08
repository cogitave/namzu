---
'@namzu/cli': major
---

Enter no longer approves a tool-permission prompt

**Press `y` to approve.** `Enter` now decides nothing at the permission
overlay. If you approve by reflex with `Enter`, that reflex has to change — this
is the whole of the break, and it is deliberate.

The prompt appears on the agent's schedule, not yours. The composer stays
editable while a turn runs, and the docs encourage typing a follow-up there, so
the overlay can take the screen while your hands are mid-sentence in the
composer behind it. `Enter` is the key most likely to be already in flight at
that moment — it is how you send the message you were typing — and it was wired
to the approving branch. The result was that the keystroke sending your
follow-up could approve a tool call you had not read. Approving is the one
decision at this prompt that cannot be undone, so it should not be reachable by
the key people press to dismiss whatever just appeared.

`Enter` was named as an approval in `docs/cli/tools.md` and nowhere else: not on
the overlay, not in the status hint. The overlay now names every key that
decides it — `y` approve, `n` / `esc` reject, `a` approve all — and names no key
that does not.

Two smaller changes come with it:

- **An approving key is ignored for 350ms after the prompt opens.** `y` and `a`
  are ordinary letters, so someone mid-word when the overlay mounts was one
  keystroke from approving. Refusal is never deferred: `n`, `Esc` and `Ctrl+C`
  answer on the first press, because a refusal you did not mean costs a retry
  and an approval you did not mean costs whatever the tool did.
- **`Esc` is now advertised on the overlay.** It always rejected; it said so
  nowhere.
