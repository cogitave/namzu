---
'@namzu/cli': minor
'@namzu/sdk': minor
---

Add `/compact`, which shrinks a conversation when you ask rather than when a threshold decides.

The machinery already existed — `compactNow` is exported from `@namzu/sdk` and its comment says it is "compaction a host can ASK for" — and no host asked. A long session could only be compacted by crossing a token threshold mid-turn, which is the moment you least want a model call, or by clearing it and losing everything.

`/compact` summarises the older half and keeps the recent turns. What it does with the transcript is the part worth knowing: the transcript is **trimmed** to the surviving turns rather than rebuilt from the returned messages. The two are not the same list — the transcript also holds tool rows, per-tool glyphs and collapsed bodies the model never saw, and rebuilding would produce a correct conversation while erasing how the surviving turns looked. Tool rows belonging to a kept turn stay with it, because an answer on screen with no visible cause is worse than a longer transcript.

A conversation too short to shed anything says so instead of reporting a compaction that did not happen, and the summary is attached to the row as collapsible detail — it is what the model reads from here on, so it has to be inspectable.

`CompactNowInput` and `CompactionResult` are now exported from `@namzu/sdk`. `compactNow` was on the public surface and its parameter and return types were not, so the first host to call it had to inline the shapes.
