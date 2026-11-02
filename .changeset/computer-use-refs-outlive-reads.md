---
'@namzu/sdk': minor
'@namzu/computer-use': minor
'@namzu/cli': patch
---

A `ui_snapshot` ref now names a control and survives later snapshots, a large window is shown as an outline you open one region at a time, and an action on a ref that no longer fits fails with a typed reason instead of acting on whatever is there.

What changes for the model: refs (`e12`) no longer die at the next `ui_snapshot`. `ui_act` finds the control again by its id, its place in the tree, then its role and name, and only then sends anything; if the control has gone the step fails with `STALE_REF`, and if several controls fit it fails with `AMBIGUOUS_TARGET`. Both mean nothing was sent, so it is safe to take a new snapshot and choose again. A window with more than about 220 controls comes back as an outline in which a region is marked `(+N more inside)` and has a ref; `ui_snapshot { root: <ref> }` reads that region alone (`offset` for the next page of a long one) and leaves every other ref usable, and `ui_snapshot { query: <text> }` lists only matching controls. The advice to "read a smaller window" is replaced by "drill into a region".

What changes for a host (additive and optional): `ComputerUseHost.uiSnapshot(windowId?, options?)` takes `UiSnapshotOptions` (`root`, `offset`, `query`); `UiElement` gains `hiddenChildren`; `UiSnapshot` gains `outline`, `total`, `region` and `next`; `UiActResult` gains `code` (`UiActFailureCode`: `STALE_REF`, `AMBIGUOUS_TARGET`). A host that ignores the new options keeps working: its refs are simply treated as stable for as long as it keeps them valid. The tool no longer discards the refs of earlier snapshots, so a host that reuses a ref string for a different control must not.

What changes in the Windows backend (`@namzu/computer-use`): refs carry identity evidence (automation id, role and name, tree path, window) and are re-resolved against a new read when older than 3 s, when a newer read of the window replaced the driver's handle, or after a driver restart; the same id under a different name is not accepted as the same control. The window is walked with the driver's own 5 000 node cap, a browser window is read once more when its first walk shows only the frame, and a control that holds nothing is no longer made the parent of rows the driver reported below a skipped level. Code that relied on an old ref being refused after the next snapshot, or on the exact wording "not a control of the latest ui_snapshot", should read `code` and `delivery` instead. This is `minor` for `@namzu/computer-use`: the refusal of an old ref has become a successful re-resolution, which no documented contract promised to preserve.

The CLI's permission review reads the new `ui_snapshot` fields (`root`, `offset`, `query`) as the read-only requests they are, instead of asking about an unknown field.
