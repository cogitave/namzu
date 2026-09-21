/**
 * How many checkpoints a CLI turn keeps: its newest ten.
 *
 * Passed to the kernel as `turnConfig.pruneKeepLast`, which prunes the
 * session's `checkpoints/` through the checkpoint store's `prune`. The
 * kernel's default is to keep every one, and a turn takes one per iteration
 * plus one per tool review. Nothing in the CLI reads an older one: a resume —
 * `namzu resume`, a drain, the TUI continuing a paused turn — reads the
 * checkpoint it was handed or the newest, and an approval waits on a
 * checkpoint an open decision references, which pruning never collects
 * whatever its age. What the rest were doing was filling the disk: 19,014
 * checkpoint files and 6.33 GB on one machine before this existed.
 *
 * Ten rather than one is margin, not a feature: the recent past stays on disk
 * for someone inspecting a turn by hand, and the bound is what matters.
 */
export const CLI_CHECKPOINT_RETENTION = 10
