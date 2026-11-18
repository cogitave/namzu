import type { PermissionResponse, PermissionView } from './protocol.js'

/** What a person can type to redirect the agent; the card keeps its own prefix inside this. */
export const PERMISSION_FEEDBACK_MAX = 4_000
/** The CLI may be another version, so a preview is checked and bounded before it reaches a window. */
const PREVIEW_MAX_CHARS = 1_100_000
const MAX_CALLS = 64

/** The words a settings change is shown in, bounded; a call without them is drawn as any other. */
function readSettingChange(
	value: unknown,
): { setting: string; from: string; to: string } | undefined {
	if (!record(value)) return undefined
	const setting = text(value.setting, 120)
	const from = text(value.from, 700)
	const to = text(value.to, 700)
	return setting && from && to ? { setting, from, to } : undefined
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | undefined =>
	typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined

/** What the agent said about a computer call, bounded; anything else is an ordinary call. */
function readComputerCall(
	value: unknown,
): { app?: string; apps?: string[]; consequence?: string } | undefined {
	if (!record(value)) return undefined
	const app = text(value.app, 120)
	const consequence = text(value.consequence, 300)
	const apps = Array.isArray(value.apps)
		? value.apps
				.slice(0, 8)
				.map((entry) => text(entry, 120))
				.filter((entry): entry is string => Boolean(entry))
		: []
	return app || consequence
		? {
				...(app ? { app } : {}),
				...(apps.length > 1 ? { apps } : {}),
				...(consequence ? { consequence } : {}),
			}
		: undefined
}

const lineCount = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined

/** The answer a window sent, checked. Throws a sentence a person can read. */
export function readPermissionResponse(value: unknown): PermissionResponse {
	if (
		!record(value) ||
		(value.outcome !== 'approve' && value.outcome !== 'approve_all' && value.outcome !== 'reject')
	)
		throw new Error('Invalid approval.')
	if (value.feedback === undefined && value.note === undefined) return { outcome: value.outcome }
	// Only a reject carries words; an approval of either kind has none.
	if (value.outcome !== 'reject') throw new Error('Invalid approval.')
	if (
		(value.feedback !== undefined && typeof value.feedback !== 'string') ||
		(value.note !== undefined && typeof value.note !== 'string')
	)
		throw new Error('Invalid approval.')
	if ((value.feedback?.length ?? 0) > PERMISSION_FEEDBACK_MAX)
		throw new Error('Keep the note under 4,000 characters.')
	// The note is kept apart from the wrapper `feedback` carries, so the record
	// holds what the person typed; it is bounded on its own.
	if ((value.note?.length ?? 0) > PERMISSION_FEEDBACK_MAX)
		throw new Error('Keep the note under 4,000 characters.')
	const feedback = value.feedback?.trim()
	const note = value.note?.trim()
	return {
		outcome: 'reject',
		...(feedback ? { feedback } : {}),
		...(note ? { note } : {}),
	}
}

/** The calls of a permission request, with a malformed or oversized preview dropped rather than shown. */
export function readPermissionCalls(value: unknown): PermissionView['calls'] {
	if (!Array.isArray(value)) return []
	const calls: PermissionView['calls'] = []
	for (const raw of value.slice(0, MAX_CALLS)) {
		if (!record(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') continue
		const call: PermissionView['calls'][number] = {
			id: raw.id,
			name: raw.name,
			input: raw.input,
			isDestructive: raw.isDestructive === true,
			// Only the agent's literal word counts; anything else is an ordinary call.
			...(raw.alwaysAsk === true ? { alwaysAsk: true as const } : {}),
		}
		const computer = readComputerCall(raw.computer)
		if (computer) call.computer = computer
		const settingChange = readSettingChange(raw.settingChange)
		if (settingChange) call.settingChange = settingChange
		const preview = raw.preview
		if (
			record(preview) &&
			typeof preview.path === 'string' &&
			preview.path.length > 0 &&
			preview.path.length <= 4096 &&
			(preview.before === null || typeof preview.before === 'string') &&
			typeof preview.after === 'string' &&
			(preview.before === null || preview.before.length <= PREVIEW_MAX_CHARS) &&
			preview.after.length <= PREVIEW_MAX_CHARS
		) {
			call.preview = {
				path: preview.path,
				before: preview.before,
				after: preview.after,
				...(preview.truncated === true ? { truncated: true } : {}),
				...(lineCount(preview.added) !== undefined ? { added: lineCount(preview.added) } : {}),
				...(lineCount(preview.removed) !== undefined
					? { removed: lineCount(preview.removed) }
					: {}),
			}
		}
		calls.push(call)
	}
	return calls
}
