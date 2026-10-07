import type { PermissionResponse, PermissionView } from './protocol.js'

/** What a person can type to redirect the agent; the card keeps its own prefix inside this. */
export const PERMISSION_FEEDBACK_MAX = 4_000
/** The CLI may be another version, so a preview is checked and bounded before it reaches a window. */
const PREVIEW_MAX_CHARS = 1_100_000
const MAX_CALLS = 64

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/** The answer a window sent, checked. Throws a sentence a person can read. */
export function readPermissionResponse(value: unknown): PermissionResponse {
	if (!record(value) || (value.outcome !== 'approve' && value.outcome !== 'reject'))
		throw new Error('Invalid approval.')
	if (value.feedback === undefined) return { outcome: value.outcome }
	if (value.outcome !== 'reject' || typeof value.feedback !== 'string')
		throw new Error('Invalid approval.')
	if (value.feedback.length > PERMISSION_FEEDBACK_MAX)
		throw new Error('Keep the note under 4,000 characters.')
	const feedback = value.feedback.trim()
	return feedback ? { outcome: 'reject', feedback } : { outcome: 'reject' }
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
		}
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
			}
		}
		calls.push(call)
	}
	return calls
}
