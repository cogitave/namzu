import type { CommitPreviewView } from '../shared/commit-protocol.js'

export interface CommitButtonInput {
	/** The conversation has changed at least one file, by its own edits. */
	hasChanges: boolean
	/** The folder is trusted: git is never run in one that is not. */
	trusted: boolean
	/** The folder is a Git repository (the branch could be read). */
	repository: boolean
	/** A reply is being written: its files are not settled. */
	running: boolean
}

export interface CommitButtonState {
	enabled: boolean
	/** Why it is off, in a sentence; absent when it works. */
	reason?: string
}

/** Whether "Commit changes" works now, and if not, why, in the person's words. */
export function commitButtonState(input: CommitButtonInput): CommitButtonState {
	if (!input.hasChanges) return { enabled: false, reason: 'Nothing to commit' }
	if (!input.trusted) return { enabled: false, reason: 'Trust this folder to commit in it' }
	if (!input.repository) return { enabled: false, reason: 'Commit needs a Git repository' }
	if (input.running) return { enabled: false, reason: 'Wait for the reply to finish' }
	return { enabled: true }
}

export interface CommitDialogModel {
	paths: string[]
	canCommit: boolean
	/** Why Commit is off while there are files, or undefined. */
	reason?: string
	lines: string[]
}

/** What the dialog says and allows, from the preview, the ticked files and the message. */
export function commitDialogModel(
	preview: CommitPreviewView,
	ticked: ReadonlySet<string>,
	message: string,
): CommitDialogModel {
	const paths = preview.files.filter((file) => ticked.has(file.path)).map((file) => file.path)
	const lines: string[] = []
	if (preview.otherDirty > 0)
		lines.push(
			`${preview.otherDirty} other ${preview.otherDirty === 1 ? 'change' : 'changes'} will not be included.`,
		)
	if (preview.skippedSecrets > 0)
		lines.push(
			`${preview.skippedSecrets} ${preview.skippedSecrets === 1 ? 'file' : 'files'} left out: the name suggests it may hold a secret.`,
		)
	const localSettings = preview.skippedLocalSettings ?? 0
	if (localSettings > 0)
		lines.push(
			localSettings === 1
				? 'Namzu’s settings file for this computer is left out: it holds your own answers, not the project’s.'
				: `${localSettings} of Namzu’s settings files for this computer are left out: they hold your own answers, not the project’s.`,
		)
	if (preview.detached) lines.push('You are not on a branch.')
	lines.push('Namzu will not push.')
	const reason = preview.blocker
		? preview.blocker
		: paths.length === 0
			? 'Choose at least one file.'
			: message.trim() === ''
				? 'Write a message.'
				: undefined
	return { paths, canCommit: reason === undefined, ...(reason ? { reason } : {}), lines }
}

/** The files this conversation changed, from its edit receipts, once each. */
export function changedPaths(receipts: readonly { path?: string | undefined }[]): string[] {
	const seen = new Set<string>()
	for (const receipt of receipts) if (receipt.path) seen.add(receipt.path)
	return [...seen]
}
