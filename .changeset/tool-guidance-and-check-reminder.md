---
'@namzu/sdk': minor
---

With `completionAudit` on, the audit's one reminder now also fires, with its own wording, when the turn's outcome record says the only checks ran with their exit status hidden (for example `npm test 2>&1 | tail -15`, which the audit used to count as a check), when a check passed and files then changed, and when a check failed; the original message and the once-per-turn limit are unchanged, and nothing fires when the audit is off or no write tool changed a file. A host that turns the audit on will see the reminder in turns where it used to see none; to keep the old behaviour, leave `completionAudit` off. The built-in tool text also changes: `bash` says to use `read`, `grep` and `glob` instead of shell loops and to run a check without a pipe, `grep` and `glob` name each other, `edit`'s not-found and not-unique errors add a hint (reason codes unchanged), and `read` words a window the caller asked for as "Lines a-b of N, as asked." instead of a "PARTIAL view" marker (only a cut the kernel imposed keeps that marker). A host that matched the old window wording should match the new one.

The default tool block grew 147 bytes (17850 to 17997, about 37 tokens) and stays under its 18000-byte ceiling: the `bash` description no longer repeats the heredoc rule that its `command` parameter already states.
