import type {
	DesktopTurnUndo,
	DesktopUndoConflictReason,
	DesktopUndoFile,
	DesktopUndoPreview,
	DesktopUndoResult,
	DesktopUndoSkipReason,
} from '../shared/protocol.js'

/** What a reply's card offers, read from the CLI's status and never from component state. */
export type UndoCardView =
	| { kind: 'enabled' }
	| { kind: 'disabled'; reason: string }
	| { kind: 'undone'; at?: number }
	| { kind: 'partial'; kept?: number }

/** `undefined` hides the button: nothing undoable, still streaming, or the CLI cannot undo. */
export function undoCardView(
	row: DesktopTurnUndo | undefined,
	options: { busy: boolean; kept?: number },
): UndoCardView | undefined {
	if (!row || row.status === 'none') return undefined
	if (row.status === 'expired') return { kind: 'disabled', reason: 'Undo expired' }
	if (row.status === 'undone')
		return { kind: 'undone', ...(row.undoneAt ? { at: row.undoneAt } : {}) }
	if (options.busy) return { kind: 'disabled', reason: 'Wait for the current reply' }
	if (row.status === 'partially_undone')
		return { kind: 'partial', ...(options.kept === undefined ? {} : { kept: options.kept }) }
	return { kind: 'enabled' }
}

export function partialLabel(kept?: number): string {
	if (kept === undefined) return 'Partly undone'
	return `Partly undone, ${kept} ${kept === 1 ? 'file' : 'files'} kept`
}

export const conflictText: Record<DesktopUndoConflictReason, string> = {
	drifted: 'Changed since this reply',
	'later-reply': 'A later reply changed it too',
	unavailable: 'The saved copy is gone',
	symlink: 'Now a link, left alone',
	'outside-cwd': 'Now outside this project',
}
export const skipText: Record<DesktopUndoSkipReason, string> = {
	'too-large': 'Larger than 8 MiB',
	'outside-cwd': 'Outside the project folder',
	sandbox: 'Edited inside a sandbox',
	'snapshot-failed': 'Could not be saved',
}

export type UndoChoice = 'skip' | 'keep_copy'
export type UndoChoices = Record<string, UndoChoice>

/** Only a file the reply's own edit left behind and the user changed can be forced, with a copy kept. */
export function canKeepCopy(file: DesktopUndoFile): boolean {
	return file.action === 'conflict' && file.reason === 'drifted'
}

/** A conflict is skipped unless the person chose otherwise; stale choices for other paths drop. */
export function normalizeChoices(preview: DesktopUndoPreview, choices: UndoChoices): UndoChoices {
	const next: UndoChoices = {}
	for (const file of preview.files)
		if (canKeepCopy(file) && choices[file.path] === 'keep_copy') next[file.path] = 'keep_copy'
	return next
}

export interface UndoSummary {
	/** Files the undo will write or remove, kept copies included. */
	changing: number
	skipping: number
	nothing: number
}
export function summarize(preview: DesktopUndoPreview, choices: UndoChoices): UndoSummary {
	let changing = 0
	let skipping = 0
	let nothing = 0
	for (const file of preview.files) {
		if (file.action === 'restore' || file.action === 'delete') changing += 1
		else if (file.action === 'conflict')
			if (canKeepCopy(file) && choices[file.path] === 'keep_copy') changing += 1
			else skipping += 1
		else nothing += 1
	}
	return { changing, skipping, nothing }
}

/** Files an undo changed on disk, counting those of later replies it also undid. */
export function undoneFileCount(result: DesktopUndoResult): number {
	const changed = (files: Record<string, string>) =>
		Object.values(files).filter((value) => value === 'restored' || value === 'removed').length
	return (
		changed(result.files) +
		Object.values(result.later ?? {}).reduce((sum, files) => sum + changed(files), 0)
	)
}

/** The words and tone of the toast that reports an undo, so zero files never reads as a success. */
export function undoNotice(result: DesktopUndoResult): {
	text: string
	tone: 'success' | 'warning'
} {
	const changed = undoneFileCount(result)
	const files = `${changed} ${changed === 1 ? 'file' : 'files'}`
	if (changed === 0) return { text: 'No files were changed.', tone: 'warning' }
	if (result.status === 'partially_undone')
		return { text: `Undid ${files}; some were left as they are.`, tone: 'warning' }
	return { text: `Undid changes to ${files}.`, tone: 'success' }
}

export function primaryLabel(count: number): string {
	return count === 0 ? 'Nothing to undo' : `Undo ${count} ${count === 1 ? 'file' : 'files'}`
}

/** Only the choices that differ from the default travel; the CLI skips every other conflict. */
export function resolutionsFor(
	preview: DesktopUndoPreview,
	choices: UndoChoices,
): Record<string, 'keep_copy'> {
	const out: Record<string, 'keep_copy'> = {}
	for (const file of preview.files)
		if (canKeepCopy(file) && choices[file.path] === 'keep_copy') out[file.path] = 'keep_copy'
	return out
}

export function queuedWarning(queued: number): string | undefined {
	if (queued <= 0) return undefined
	return `${queued} queued ${queued === 1 ? 'message was' : 'messages were'} written against the files as they are now and will run after the undo.`
}

export const SHELL_WARNING =
	'This reply also ran shell commands. Undo cannot reverse what they changed.'
