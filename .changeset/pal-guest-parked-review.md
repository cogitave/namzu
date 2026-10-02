---
'@namzu/cli': minor
---

Resume a Pal's real parked tool review in its original session and local guest
computer. Explicit review holds record durable checkpoints, preserve the
conversation's pinned profile and original turn limits on resume, and hold later
batches for their own decision. Existing live terminal permission prompts keep
their behavior when no hold is requested.

Trusted hosts can authenticate one-batch review actions against the exact
original journal request and current consent. Durable operation and decision
reservations prevent automatic replay, and acknowledgement requires an actual
recorded decision resolution. Unconfirmed attempts retain their ownership for
reconciliation rather than executing again.

The required trusted host `currentPermissionMode` callback keeps current plan
mode stricter than a restored approval and later rule-allowed batches. Channel
action payloads cannot change the mode or substitute the captured host ports.
For this action, `auto` and `accept-edits` are limited to `prompt` on later
review requests, so a one-batch answer never grants automatic later approval.
Independent operator rules and ordinary CLI automatic modes retain their
existing behavior.
