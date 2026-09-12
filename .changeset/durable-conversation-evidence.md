---
"@namzu/cli": major
---

Durable `drain` now mounts `search_conversation` and `read_conversation` under
the persisted conversation's ownership and honors configured compaction,
memory and web options. These options were previously omitted from its host.
It can recover original retained command output without running the command
again or treating an internal backing file as workspace content.

The retained-output preview default on this entrypoint now follows the CLI's
4,000-character setting instead of its previous 40,000-character preview. Set
`compaction.retainedToolPreviewChars: 0` to preserve the former preview behavior.
Previously ignored compaction, memory and web configuration now takes effect;
review those keys when upgrading an unattended drainer.

A resumed run that ends as failed or cancelled is now reported in `failed`
with exit code 1 instead of being reported as a successful drain.
