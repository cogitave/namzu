import type {
	DesktopTurnUndo,
	DesktopUndoFile,
	DesktopUndoFileResult,
	DesktopUndoPreview,
	DesktopUndoResult,
	DesktopUndoSkipped,
} from './protocol.js'

// The CLI is a separate process and may be a different version: every field is checked and
// bounded before it reaches the projection or the dialog.
const STATES = ['applied', 'undone', 'partially_undone', 'none', 'expired']
const SKIP_REASONS = ['too-large', 'outside-cwd', 'sandbox', 'snapshot-failed']
const ACTIONS = ['restore', 'delete', 'noop', 'conflict']
const REASONS = ['drifted', 'later-reply', 'unavailable', 'symlink', 'outside-cwd']
const RESULTS = ['restored', 'removed', 'skipped', 'failed', 'noop']
const MAX_FILES = 10_000

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max = 4096): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= max
const count = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function readSkipped(value: unknown): DesktopUndoSkipped[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_FILES) return undefined
	const out: DesktopUndoSkipped[] = []
	for (const item of value) {
		if (!record(item) || !text(item.path) || !SKIP_REASONS.includes(item.reason as string))
			return undefined
		out.push({ path: item.path, reason: item.reason as DesktopUndoSkipped['reason'] })
	}
	return out
}

export function readUndoStatus(value: unknown): DesktopTurnUndo[] | undefined {
	if (!record(value) || !Array.isArray(value.turns) || value.turns.length > 5_000) return undefined
	const out: DesktopTurnUndo[] = []
	for (const item of value.turns) {
		if (!record(item)) return undefined
		const skipped = readSkipped(item.skipped)
		if (
			!text(item.turnId, 200) ||
			!STATES.includes(item.status as string) ||
			!count(item.files) ||
			!count(item.added) ||
			!count(item.removed) ||
			typeof item.uncoveredShell !== 'boolean' ||
			!skipped
		)
			return undefined
		out.push({
			turnId: item.turnId,
			status: item.status as DesktopTurnUndo['status'],
			files: item.files,
			added: item.added,
			removed: item.removed,
			uncoveredShell: item.uncoveredShell,
			skipped,
		})
	}
	return out
}

export function readUndoPreview(value: unknown): DesktopUndoPreview | undefined {
	if (
		!record(value) ||
		!text(value.turnId, 200) ||
		!['applied', 'undone', 'partially_undone'].includes(value.status as string) ||
		!text(value.planToken, 200) ||
		!Array.isArray(value.files) ||
		value.files.length > MAX_FILES ||
		typeof value.uncoveredShell !== 'boolean' ||
		!Array.isArray(value.laterTurnsOnSameFiles) ||
		value.laterTurnsOnSameFiles.length > 500 ||
		value.laterTurnsOnSameFiles.some((id) => !text(id, 200))
	)
		return undefined
	const skipped = readSkipped(value.skipped)
	if (!skipped) return undefined
	const files: DesktopUndoFile[] = []
	for (const file of value.files) {
		if (
			!record(file) ||
			!text(file.turnId, 200) ||
			!text(file.path) ||
			typeof file.rel !== 'string' ||
			file.rel.length > 4096 ||
			!ACTIONS.includes(file.action as string) ||
			(file.reason !== undefined && !REASONS.includes(file.reason as string)) ||
			(file.blockedBy !== undefined &&
				(!Array.isArray(file.blockedBy) ||
					file.blockedBy.length > 500 ||
					file.blockedBy.some((id) => !text(id, 200))))
		)
			return undefined
		files.push({
			turnId: file.turnId,
			path: file.path,
			rel: file.rel || file.path,
			action: file.action as DesktopUndoFile['action'],
			...(file.reason ? { reason: file.reason as DesktopUndoFile['reason'] } : {}),
			...(file.blockedBy ? { blockedBy: file.blockedBy as string[] } : {}),
		})
	}
	return {
		turnId: value.turnId,
		status: value.status as DesktopUndoPreview['status'],
		planToken: value.planToken,
		files,
		skipped,
		uncoveredShell: value.uncoveredShell,
		laterTurnsOnSameFiles: value.laterTurnsOnSameFiles as string[],
	}
}

function readResults(value: unknown): Record<string, DesktopUndoFileResult> | undefined {
	if (!record(value)) return undefined
	const entries = Object.entries(value)
	if (entries.length > MAX_FILES) return undefined
	// A null prototype, so a path named `__proto__` stays a path.
	const out = Object.create(null) as Record<string, DesktopUndoFileResult>
	for (const [path, result] of entries) {
		if (!text(path) || !RESULTS.includes(result as string)) return undefined
		out[path] = result as DesktopUndoFileResult
	}
	return out
}

export function readUndoResult(value: unknown): DesktopUndoResult | undefined {
	if (
		!record(value) ||
		!text(value.turnId, 200) ||
		!['applied', 'undone', 'partially_undone', 'plan-changed'].includes(value.status as string)
	)
		return undefined
	const files = readResults(value.files)
	if (!files) return undefined
	let later: DesktopUndoResult['later']
	if (value.later !== undefined) {
		if (!record(value.later) || Object.keys(value.later).length > 500) return undefined
		later = {}
		for (const [id, results] of Object.entries(value.later)) {
			const read = text(id, 200) ? readResults(results) : undefined
			if (!read) return undefined
			later[id] = read
		}
	}
	let copies: DesktopUndoResult['copies']
	if (value.copies !== undefined) {
		if (!Array.isArray(value.copies) || value.copies.length > MAX_FILES) return undefined
		copies = []
		for (const copy of value.copies) {
			if (!record(copy) || !text(copy.path) || !text(copy.sha256, 200)) return undefined
			copies.push({ path: copy.path, sha256: copy.sha256 })
		}
	}
	let replan: DesktopUndoPreview | undefined
	if (value.replan !== undefined) {
		replan = readUndoPreview(value.replan)
		if (!replan) return undefined
	}
	if (value.status === 'plan-changed' && !replan) return undefined
	return {
		turnId: value.turnId,
		status: value.status as DesktopUndoResult['status'],
		files,
		...(later ? { later } : {}),
		...(copies ? { copies } : {}),
		...(replan ? { replan } : {}),
	}
}
