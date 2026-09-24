import type { ToolResult } from '../../types/tool/index.js'
import type { ToolCallView, ToolResultView } from '../../types/tool/presentation.js'

/**
 * How the schedule tools read to a person: in words, never ids or JSON.
 */

const MAX = 80

function oneLine(value: unknown): string {
	if (typeof value !== 'string') return ''
	const flat = value.replace(/\s+/g, ' ').trim()
	return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat
}

function activity(label: string): ToolCallView {
	return { kind: 'generic', presentation: 'activity', label }
}

const HIDDEN: ToolResultView = { kind: 'generic', label: '', visibility: 'hidden' }

export function presentScheduleCall(input: {
	readonly action?: unknown
	readonly name?: unknown
	readonly when?: unknown
	readonly job?: unknown
}): ToolCallView {
	switch (input.action) {
		case 'create': {
			const name = oneLine(input.name)
			const when = oneLine(input.when)
			return activity(`Propose scheduled job${name ? ` · ${name}` : ''}${when ? ` · ${when}` : ''}`)
		}
		case 'list':
			return activity('List scheduled jobs')
		case 'update':
			return activity(`Change scheduled job · ${oneLine(input.job)}`)
		case 'pause':
			return activity(`Pause scheduled job · ${oneLine(input.job)}`)
		case 'resume':
			return activity(`Resume scheduled job · ${oneLine(input.job)}`)
		case 'delete':
			return activity(`Delete scheduled job · ${oneLine(input.job)}`)
		default:
			return activity('Scheduled jobs')
	}
}

/** The operator answered no on the tool's own screen: not a failure. */
function operatorCancelled(result: ToolResult): boolean {
	const data = result.data as { cancelled?: unknown } | undefined
	return data?.cancelled === true
}

export function presentScheduleResult(input: unknown, result: ToolResult): ToolResultView {
	if (!result.success && operatorCancelled(result)) {
		const action = (input as { action?: unknown } | null)?.action
		return {
			kind: 'generic',
			outcome: 'cancelled',
			label: action === 'create' ? 'Cancelled — no job was created' : 'Cancelled — nothing changed',
		}
	}
	if (!result.success) return { kind: 'generic', label: oneLine(result.error) || 'Not done' }
	return HIDDEN
}

export function presentLoopCall(input: {
	readonly action?: unknown
	readonly interval?: unknown
	readonly prompt?: unknown
}): ToolCallView {
	switch (input.action) {
		case 'create':
			return activity(`Loop ${oneLine(input.interval)} · ${oneLine(input.prompt)}`)
		case 'list':
			return activity('List loops')
		case 'delete':
			return activity('Stop loop')
		default:
			return activity('Loops')
	}
}

export function presentLoopResult(_input: unknown, result: ToolResult): ToolResultView {
	if (!result.success) return { kind: 'generic', label: oneLine(result.error) || 'Not done' }
	return HIDDEN
}
