---
type: Reference
title: Manual compaction and original-message retention
description: Publishing host-requested compaction only after removed originals have been retained.
resource: packages/sdk/src/compaction/manual.ts
tags: [sdk, compaction, persistence, evidence]
---

# Manual compaction

`compactNow` reduces a host-owned history; `compactRegion` reduces a selected
valid span. Neither mutates the supplied array or owns a running invocation.
The result contains replacement `messages`, the pinned `summary`, net `shed`
count and optional verifier `usage`. `null` means no reduction is available.

Generated summaries carry the optional `SystemMessage.source` value
`{ type: 'compaction-summary' }`. This host provenance distinguishes a derived
summary from ordinary system text, independent of its heading. Automatic
compaction uses the same marker; a replaced summary keeps it when archived.
Manual summaries retain their `retain: true` protection. This addition does not
change the existing leading-summary replacement or retention rules.

Both accept optional `onShed(removedMessages)`. The SDK awaits this callback
before returning a replacement. It receives original messages absent from the
replacement, in input order, including removed system messages. Retained messages
are excluded by object identity. This list is distinct from `result.shed`, which
is the net count after adding a summary. The callback must not mutate its input.

Use the callback to retain originals in a host-owned archive. A rejected write
rejects compaction, leaving the supplied history unchanged. A no-op invokes no
callback. The signal is checked before retention and again afterward. Retention
is awaited to settlement, so a callback doing asynchronous I/O should observe
the same signal through its closure. Cancellation does not roll back already
written archive records. It prevents publication of the replacement.

The hook is optional: without it, these helpers still only return a projection;
they do not promise an archive. Automatic in-run compaction separately retains
removed messages through `compaction_shed` when `recordShedHistory` is enabled.

`SessionEvent`'s `compaction_shed.reason` and the `SessionQuery` `ShedPass.reason` now
also admit `manual`. Consumers with exhaustive reason handling must add that
case. It identifies a host-requested pass, not a provider rejection or threshold.
Its timestamp dates the archive copy, not the original user's submission.

The [CLI implementation](../cli/context-and-compaction.md) binds the hook to
the current conversation and reuses the SDK's scoped run evidence index. Other
hosts choose their own storage; the SDK does not depend on CLI paths or stores.

The disk store's [large-message encoding](retained-tool-evidence.md) also applies
to manually retained `compaction_shed` events. It keeps original attachments and
metadata outside the bounded transcript line, without changing the public event
returned by full SDK readers.
