/**
 * What changed in a job since someone last confirmed it, for the person
 * confirming it again.
 *
 * An edit is confirmed again whole, and the preview is long: a site added to
 * a browser grant was one line among forty. The lines that differ from the
 * version last confirmed are shown on their own, above the question, as
 * `+ added` and `- removed`. An edit saved without a terminal (`--yes`) is
 * confirmed later, by `schedule confirm` or the TUI, so the edit records its
 * changes in the job's history and the confirmation reads them back.
 */

import { previewLines } from './build.js'
import type { CompiledJobPolicy } from './policy.js'
import { stableStringify } from './store/jobs.js'
import type { ScheduleHistoryRecord, ScheduleJob } from './types.js'

/**
 * Whether an edit changes what a run may do: its rules, `unmatched`, where
 * it runs, its additional directories or its browser grant. Only `preset`,
 * a label for display, is left out.
 */
export function permissionsChanged(before: ScheduleJob, after: ScheduleJob): boolean {
	const what = ({ preset: _, ...rest }: ScheduleJob['permissions']) => stableStringify(rest)
	return what(before.permissions) !== what(after.permissions)
}

/** The preview as compared: without the next fire times, which change by the minute. */
export function confirmationView(job: ScheduleJob, policy: CompiledJobPolicy, now: Date): string[] {
	return [
		...previewLines(job, policy, now).filter((line) => !line.startsWith('Next ')),
		...job.prompt.split('\n').map((line) => `Prompt  ${line}`),
	]
}

/** `+ line` for each line only in `after`, `- line` for each only in `before`. */
export function describeChanges(before: readonly string[], after: readonly string[]): string[] {
	const was = new Set(before.map((line) => line.trim()))
	const now = new Set(after.map((line) => line.trim()))
	return [
		...before.filter((line) => !now.has(line.trim())).map((line) => `- ${line.trim()}`),
		...after.filter((line) => !was.has(line.trim())).map((line) => `+ ${line.trim()}`),
	]
}

/** Records that mean a person confirmed the job as it then stood. */
function confirmedHere(record: ScheduleHistoryRecord): boolean {
	if (record.kind !== 'job') return false
	if (record.action === 'confirmed') return true
	return (
		(record.action === 'created' || record.action === 'edited') &&
		record.by !== 'cli-noninteractive'
	)
}

/** The changes recorded by edits saved since the job was last confirmed, oldest first. */
export function changesSinceConfirmed(history: readonly ScheduleHistoryRecord[]): string[] {
	const out: string[] = []
	for (const record of history) {
		if (confirmedHere(record)) out.length = 0
		else if (record.kind === 'job' && record.action === 'edited' && record.changes)
			out.push(...record.changes)
	}
	return out
}

/** The block shown above the question, or nothing. */
export function changesBlock(changes: readonly string[]): string[] {
	return changes.length === 0
		? []
		: ['Changed since it was last confirmed', ...changes.map((line) => `  ${line}`)]
}
