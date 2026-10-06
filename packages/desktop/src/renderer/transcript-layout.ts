import type { ThreadState, TimelineEntry } from '../shared/projection.js'
import type { ToolTranscriptState } from './tool-transcript-presentation.js'

export interface TranscriptTurn {
	turn: number
	user: TimelineEntry[]
	activity: TimelineEntry[]
	answer: TimelineEntry[]
}

export function toolGroupLabel(
	tools: ThreadState['tools'][string][],
	active: boolean,
	states?: ToolTranscriptState[],
): string {
	const commands = tools.some(
		(tool) =>
			(tool.view.kind === 'terminal' && tool.view.command?.trim()) ||
			(tool.callView?.kind === 'terminal' && tool.callView.command?.trim()),
	)
	const edits = tools.some((tool) => tool.view.kind === 'diff' && tool.view.path?.trim())
	const names = [edits ? 'File changes' : '', commands ? 'Commands' : ''].filter(Boolean).join(', ')
	if (states?.some((state) => !['running', 'completed'].includes(state))) {
		const counts = new Map<ToolTranscriptState, number>()
		for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1)
		const summary = [...counts].map(
			([state, count]) =>
				`${counts.size > 1 ? `${count} ` : ''}${state === 'waiting' ? 'waiting for approval' : state}`,
		)
		return `${names || 'Actions'} · ${summary.join(', ')}`
	}
	if (active)
		return (
			[edits ? 'Editing files' : '', commands ? 'Running commands' : '']
				.filter(Boolean)
				.join(', ') || 'Working on actions'
		)
	if (tools.every((tool) => tool.status === 'completed'))
		return (
			[edits ? 'Edited files' : '', commands ? 'Ran commands' : ''].filter(Boolean).join(', ') ||
			'Actions completed'
		)
	return `${names || 'Actions'} · ${tools.some((tool) => tool.status === 'failed') ? 'failed' : 'interrupted'}`
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
		const work = entries.filter((entry) => {
			if (user.includes(entry)) return false
			if (entry.kind === 'tool') return Boolean(thread.tools[entry.id])
			if (entry.kind === 'reasoning') return Boolean(thread.reasoning[entry.id]?.text.trim())
			const message = thread.messages[entry.index]
			return Boolean(message?.text.trim() || message?.attachments?.length)
		})
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

export function transcriptOutcome(
	reason?: string,
): 'completed' | 'paused' | 'stopped' | 'incomplete' | 'unknown' {
	if (!reason) return 'unknown'
	if (reason === 'end_turn' || reason === 'stop_condition') return 'completed'
	if (reason === 'paused' || reason === 'pause_turn') return 'paused'
	if (reason === 'cancelled' || reason === 'canceled' || reason === 'aborted') return 'stopped'
	return 'incomplete'
}

export function terminalNotice(reason?: string): string | undefined {
	const outcome = transcriptOutcome(reason)
	if (outcome === 'unknown' || outcome === 'completed') return undefined
	if (outcome === 'paused') return 'Paused.'
	if (outcome === 'stopped') return 'Stopped.'
	if (reason === 'max_turns' || reason === 'max_iterations')
		return 'The configured turn limit was reached.'
	if (reason === 'token_budget' || reason === 'max_tokens')
		return 'The configured token budget was reached.'
	if (reason === 'cost_limit') return 'The configured cost limit was reached.'
	if (reason === 'cost_unmeasurable')
		return 'Stopped because the configured cost budget could not be measured.'
	if (reason === 'timeout') return 'This turn timed out.'
	if (reason === 'step_refused') return 'Stopped by the configured execution policy.'
	if (reason === 'refused') return 'The action was declined.'
	if (reason === 'answer_rejected') return 'The response did not pass the configured review.'
	if (reason === 'plan_rejected') return 'The plan did not pass the configured review.'
	if (
		reason === 'guardrail_blocked' ||
		reason === 'input_guardrail' ||
		reason === 'output_guardrail'
	)
		return 'This turn was blocked by a configured guardrail.'
	if (reason === 'structured_output_failed')
		return 'The response did not match the required format.'
	return 'This turn could not finish.'
}
