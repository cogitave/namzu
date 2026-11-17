/**
 * What the Namzu host says about committing one conversation's changes, read before anything trusts
 * it. The desktop half of `packages/cli/src/commands/desktop-commit.ts`: `namzu/project/commit-preview`
 * says which files would be committed and suggests a message, `namzu/project/commit` commits the
 * files the person confirmed. Desktop never pushes, amends or skips a hook; that is the host's rule.
 */
export const COMMIT_PREVIEW_METHOD = 'namzu/project/commit-preview'
export const COMMIT_METHOD = 'namzu/project/commit'

export type CommitFileState = 'modified' | 'added' | 'deleted' | 'renamed'

export interface CommitFileView {
	path: string
	state: CommitFileState
	/** What the file held when it was previewed; sent back so a file changed since is refused. */
	fingerprint: string
}

export interface CommitPreviewView {
	files: CommitFileView[]
	/** Changes git sees that this conversation did not make: not included. */
	otherDirty: number
	/** Files left out because their name says they may hold a secret. */
	skippedSecrets: number
	branch: string | null
	detached: boolean
	suggestedMessage: string
	messageSource: 'model' | 'plain'
	/** Why nothing can be committed, when so. */
	blocker?: string
}

export interface CommitRequestView {
	paths: string[]
	message: string
	fingerprints: Record<string, string>
}

export interface CommitResultView {
	hash: string
	subject: string
}

/** The host answers a commit with the commit, or with why it did not happen, in its own words. */
export type CommitOutcomeView = ({ ok: true } & CommitResultView) | { ok: false; reason: string }

const MAX_FILES = 200
const MAX_TEXT = 4000

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)

function line(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
	const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
	return clean.slice(0, max)
}

const count = (value: unknown): number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e9 ? value : 0

export function readCommitPreview(value: unknown): CommitPreviewView | undefined {
	if (!isRecord(value) || !Array.isArray(value.files)) return undefined
	const files: CommitFileView[] = []
	for (const item of value.files.slice(0, MAX_FILES)) {
		if (!isRecord(item)) continue
		const path = line(item.path, 1024)
		const fingerprint = line(item.fingerprint, 128)
		const state = item.state
		if (!path || !fingerprint) continue
		if (state !== 'modified' && state !== 'added' && state !== 'deleted' && state !== 'renamed')
			continue
		files.push({ path, state, fingerprint })
	}
	const suggestedMessage = line(value.suggestedMessage, MAX_TEXT)
	if (suggestedMessage === undefined) return undefined
	const branch = value.branch === null ? null : (line(value.branch, 255) ?? null)
	const blocker = line(value.blocker, 300)
	return {
		files,
		otherDirty: count(value.otherDirty),
		skippedSecrets: count(value.skippedSecrets),
		branch,
		detached: value.detached === true,
		suggestedMessage,
		messageSource: value.messageSource === 'model' ? 'model' : 'plain',
		...(blocker ? { blocker } : {}),
	}
}

export function readCommitOutcome(value: unknown): CommitOutcomeView | undefined {
	if (!isRecord(value)) return undefined
	if (value.ok === false) {
		const reason = line(value.reason, 2000)?.trim()
		return reason ? { ok: false, reason } : undefined
	}
	if (value.ok !== true) return undefined
	const hash = line(value.hash, 64)
	const subject = line(value.subject, 500)
	if (!hash || subject === undefined || !/^[0-9a-f]+$/i.test(hash)) return undefined
	return { ok: true, hash, subject }
}
