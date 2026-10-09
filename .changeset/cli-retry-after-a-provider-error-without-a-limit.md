---
"@namzu/cli": minor
---

A paused provider turn that has no token limit can now be retried in place even when earlier requests have unknown usage (a 502 is the usual cause). `namzu/sessions/retry-status` then answers `{ retry, unknownUsage: <count> }` instead of a notice, and the retry is a new request; the unknown usage stays recorded. A turn with a finite limit still answers the notice and refuses the retry, so an ACP or Desktop client that treated every unresolved-usage pause as "cannot retry" will now see a retry target for unlimited turns.

Desktop connections gain `namzu/sessions/abandon-paused` (optional `turnId`): it closes the paused provider turn without repeating it (`turn_failed`, code `abandoned`, its unknown usage kept on the ledger) so the same conversation takes the next message. It refuses a turn that waits for a person's decision or did not stop on a provider error. Hosts that do not advertise the method keep today's behaviour.
