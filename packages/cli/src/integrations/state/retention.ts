import { statSync } from 'node:fs'

import { EmergencySaveManager } from '@namzu/sdk'

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

/**
 * Remove the crash dumps a session has moved past.
 *
 * A TUI turn and `namzu run` write `<runsDir>/emergency/<runId>.json` when the
 * process is interrupted mid-run. The CLI never resumes from one: the next
 * turn continues the conversation from the session record under a NEW run id,
 * so the kernel's own cleanup — which clears a dump when the same run id
 * completes — never fires for it, and every interrupted turn left the whole
 * conversation on disk for good.
 *
 * Once a later turn in the same session has COMPLETED, the conversation the
 * dump was a snapshot of has been carried on without it, so dumps older than
 * that turn's start are removed. A dump written after the turn started (by
 * another process on the same session) is left alone, and so is everything
 * when the turn did not complete. Best-effort: a dump that cannot be removed
 * is not a reason to fail a turn that succeeded.
 *
 * @returns the paths removed.
 */
export function clearOutlivedEmergencySaves(runsDir: string, turnStartedAt: number): string[] {
	const removed: string[] = []
	for (const path of EmergencySaveManager.listSaves(runsDir)) {
		try {
			if (statSync(path).mtimeMs >= turnStartedAt) continue
			EmergencySaveManager.clearSave(path)
			removed.push(path)
		} catch {
			// Gone already, or not ours to remove; either way, not this turn's problem.
		}
	}
	return removed
}
