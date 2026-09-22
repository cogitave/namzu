---
'@namzu/cli': minor
---

The model's plan is drawn once, as a checklist in the transcript. Consecutive task calls fold into one block with a header in words (`Added 2 tasks`, `Started · <subject>`, `Completed · <subject>`, `Tasks · 1/2 done`) and the checklist as it stood afterwards; `/tasks` draws the same checklist. No task id, owner, JSON argument or model receipt (`Task created: <uuid> — "…" [owner: namzu]`, `1 tasks: 0 completed, …`) is shown any more. The marks are one-cell text characters with exactly one space before the subject — `□` pending, `■` in progress (bold), `✓` completed (dimmed, struck through), `✗` failed — instead of `☐`/`☑`/`☒`/`◐`, which emoji-capable fonts drew as two-cell colour pictures. The eight-row task list above the composer is gone; a single row naming the current step appears there only while the checklist is out of view. A system notice identical to the row directly before it is no longer printed a second time.
