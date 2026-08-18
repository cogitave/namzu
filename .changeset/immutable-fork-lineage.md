---
'@namzu/cli': minor
---

Make new conversation forks exportable by atomically publishing and verifying their copied model context before recording an immutable source-turn boundary. Nested forks flatten that boundary, later source turns cannot leak into it, and ambiguous or legacy prefixes remain explicitly unexportable.
