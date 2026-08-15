---
'@namzu/sdk': patch
---

The oversized-tool-output spill now creates its file exclusively and owner-only.

`spill()` wrote to `<spillDir>/<toolUseId>.txt` with the default `w` flag,
which creates-or-truncates and follows a symlink, at a path anything that has
seen the tool call can predict. A file pre-planted at that path — by a hostile
or buggy tool body, a stale entry in a reused output directory, or a
co-located process on a shared sandbox mount — redirected the kernel's write
onto a target of its choosing, with content the model influenced. The
directory and file were also created with the default `0o755`/`0o644`, leaving
the largest and most sensitive artefact a run produces world-readable on a
shared host.

The write now uses `flag: 'wx'` with `mode: 0o600`, and directories this call
creates are made `0o700`. `wx` never follows a symlink and fails with `EEXIST`
rather than truncating, so a refusal is reported instead of a silent
overwrite.

Behaviour on refusal is the path that already existed for an unusable spill
directory: the call still returns, `truncated` is `true`, no `spillPath` is
set, and the model gets the head/tail preview with the "The full output was
not retained" recovery line. The `onError` message distinguishes `EEXIST` from
other failures, because a stale file is housekeeping while something arriving
at a path only this run should know is the case the exclusive open exists to
refuse.

No exported identifier changes; `spill` is module-private and
`applyToolOutputBudget`'s signature and result shape are unchanged.
