---
'@namzu/sdk': minor
'@namzu/cli': minor
---

New option `softTargetHeadroom` for the `salience` compaction strategy (`compactionConfig.softTargetHeadroom` in the SDK, `compaction.softTargetHeadroom` in `namzu.config.json` and `~/.namzu/config.yaml`): a fraction of the window from 0 to 1 that a pass sheds below the soft target. A pass still starts when the context reaches the soft target, but it then keeps shortening until the context is that much lower, so the next pass comes after the room is used instead of on the next turn, and a provider that caches the start of the request keeps its cache for longer. The messages shortened are the same ones in the same order, only earlier; the cost is that much less history kept whole. Off unless set: absent or `0` is the previous behaviour exactly, so nothing changes on upgrade.
