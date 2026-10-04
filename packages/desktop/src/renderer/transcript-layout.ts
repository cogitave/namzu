import type { ThreadState, TimelineEntry } from '../shared/projection.js'

export interface TranscriptTurn {
	turn: number
	user: TimelineEntry[]
	activity: TimelineEntry[]
	answer: TimelineEntry[]
}

export function toolGroupLabel(tools: ThreadState['tools'][string][], active: boolean): string {
	const commands = tools.some((tool) => tool.view.kind === 'terminal')
	const edits = tools.some((tool) => tool.view.kind === 'diff')
	if (active)
		return [edits ? 'Editing files' : '', commands ? 'Running commands' : '']
			.filter(Boolean)
			.join(', ')
	if (tools.every((tool) => tool.status === 'completed'))
		return [edits ? 'Edited files' : '', commands ? 'Ran commands' : ''].filter(Boolean).join(', ')
	const names = [edits ? 'File changes' : '', commands ? 'Commands' : ''].filter(Boolean).join(', ')
	return `${names} · ${tools.some((tool) => tool.status === 'failed') ? 'failed' : 'interrupted'}`
}

/** Group activity only when the admitted events actually distinguish it. */
export function transcriptTurns(thread: ThreadState): TranscriptTurn[] {
	const groups = new Map<number, TimelineEntry[]>()
	for (const entry of thread.timeline) {
		const entries = groups.get(entry.turn) ?? []
		entries.push(entry)
		groups.set(entry.turn, entries)
	}
	return [...groups].map(([turn, entries]) => {
		const user = entries.filter(
			(entry) => entry.kind === 'message' && thread.messages[entry.index]?.role === 'user',
		)
		const work = entries.filter((entry) => !user.includes(entry))
		const hasActivity = work.some(
			(entry) => entry.kind !== 'message' || thread.messages[entry.index]?.phase === 'commentary',
		)
		if (!hasActivity) return { turn, user, activity: [], answer: work }
		// An answer is a suffix: never move it across a later thought/tool event.
		let split = work.length
		while (split > 0) {
			const entry = work[split - 1]
			if (entry?.kind !== 'message') break
			const message = thread.messages[entry.index]
			if (!message || message.role !== 'assistant' || message.phase === 'commentary') break
			split -= 1
		}
		return {
			turn,
			user,
			activity: work.slice(0, split),
			answer: work.slice(split),
		}
	})
}

export function elapsedLabel(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000))
	const hours = Math.floor(seconds / 3600)
	const minutes = Math.floor((seconds % 3600) / 60)
	const remainder = seconds % 60
	return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`
}

export function terminalNotice(reason?: string): string | undefined {
	if (!reason || reason === 'end_turn') return undefined
	if (reason === 'paused') return 'Paused. You can continue from here.'
	if (reason === 'cancelled') return 'Stopped. You can continue from here.'
	if (reason === 'max_turns') return 'Turn limit reached. Review the work before continuing.'
	if (reason === 'token_budget' || reason === 'max_tokens')
		return 'The configured token budget was reached.'
	if (reason === 'cost_limit') return 'The configured cost limit was reached.'
	if (reason === 'timeout') return 'This turn timed out. You can retry from here.'
	if (reason === 'refused' || reason === 'step_refused') return 'The action was not approved.'
	if (reason === 'input_guardrail' || reason === 'output_guardrail')
		return 'This turn was blocked by a configured guardrail.'
	if (reason === 'structured_output_failed')
		return 'The response did not match the required format.'
	return 'This turn could not finish.'
}
