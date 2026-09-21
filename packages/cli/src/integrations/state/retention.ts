/**
 * How many checkpoints a CLI run keeps: its newest ten.
 *
 * The kernel's default is to keep every one, and a run takes one per
 * iteration plus one per tool review. Nothing in the CLI reads an older one:
 * a resume — `namzu resume`, a drain, the TUI continuing a paused run — reads
 * the checkpoint it was handed or the newest, and an approval waits on a
 * checkpoint whose park is unresolved, which pruning never collects whatever
 * its age. What the rest were doing was filling the disk: 19,014 checkpoint
 * files and 6.33 GB on one machine before this existed.
 *
 * Ten rather than one is margin, not a feature: the recent past stays on disk
 * for someone inspecting a run by hand, and the bound is what matters.
 */
export const CLI_CHECKPOINT_RETENTION = 10
