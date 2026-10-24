---
'@namzu/sdk': minor
---

`CompletionInbox` accepts `{ holdsTurnOpen: false }` as a second constructor argument (and the new `CompletionInboxOptions` type is exported). With it, a turn that is about to end no longer waits at its settle point for the delegated tasks it launched: it ends at the model's answer, leaves those tasks running, and does not list them as abandoned (`abandonedTaskIds` stays absent). The host then owns their completion. Nothing changes for existing callers: the default is `true`, the previous behaviour. Use it when the host keeps background tasks alive itself and wakes the model when they end, as the terminal now does.
