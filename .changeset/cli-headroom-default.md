---
'@namzu/cli': major
---

The default for `compaction.softTargetHeadroom` changes from `0` to `0.05` when you have not set it (and the strategy is `salience`, the default strategy). A compaction pass that starts at half the window now keeps shortening until the context is 5% of the window lower, instead of stopping at half. You will notice two things: passes come in batches (a few per long session) instead of one cut on nearly every turn, so a provider that caches the start of a request keeps its cache between passes; and right after a pass the context is about 5% of the window lower (10,000 tokens on a 200,000-token window), so that much less older history is kept whole. The messages shortened are the same ones in the same order, only earlier. The same default applies to the interactive session, `exec`, the desktop host, scheduled runs, and sub-agents that have a compaction configuration of their own (a sub-agent gets one only when `compaction.autoCompactWindowTokens` is set, as before). The kernel's own default in `@namzu/sdk` is unchanged.

To keep the old behaviour exactly, set `compaction.softTargetHeadroom` to `0` in `namzu.config.json` or `~/.namzu/config.yaml`:

```json
{ "compaction": { "softTargetHeadroom": 0 } }
```

A value you set, `0` included, is always used as written. The `structured` strategy gets no default headroom.
