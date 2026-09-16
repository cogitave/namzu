---
"@namzu/cli": minor
---

A correction queued with `send_message` was previously invisible: the child's transcript jumped straight from one tool call to a visibly redirected next turn, and the parent saw only a one-line "queued" acknowledgement that scrolled away. Once delivery is confirmed (never for a refused or unowned send), it now appears on both sides: the child's transcript gets a `← from parent: …` row using the existing system-row kind, and the main conversation gets a matching `<description> · correction sent` row with the message text beneath it. Each side shows the message exactly once, however many times the surface re-renders.

Minor, not patch: this is new operator-visible capability. `SubagentActivityMonitor.recordMessage()` and the `direction` field it adds to a transcript row are internal to the CLI, not exported from `@namzu/cli`'s public entry, so no published type changed shape for a consumer.
