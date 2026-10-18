/**
 * A live label for each background agent that is running.
 *
 * Every {@link LABEL_INTERVAL_MS} a running background agent is asked, once and
 * with no tools, to say in three to five words what it is doing right now. The
 * answer is shown in the rail's description column in place of the sentence it
 * was launched with, and goes away when the agent ends. The query never blocks
 * the agent: it is a separate request, one at a time per agent, and a failed or
 * malformed answer is dropped and the previous label stays.
 *
 * Timing is a plain interval so a test drives it with fake timers.
 */

import type { SubagentActivity, SubagentActivityMonitor } from './activity.js'

/** Least time between two labels of one agent. */
export const LABEL_INTERVAL_MS = 30_000
/** An agent with fewer messages than this has not done enough to describe. */
export const LABEL_MIN_MESSAGES = 3
/** Longest label kept. */
export const LABEL_MAX_CHARS = 100
/** Most of the agent's recent rows put in front of the model. */
const LABEL_CONTEXT_ROWS = 40
const LABEL_ROW_CHARS = 600

/**
 * The instruction for the one-turn query. Written for this host.
 */
export const LABEL_INSTRUCTION = [
	'Say what this agent is doing right now, as a short status label for a list.',
	'Rules: three to five words; present tense (for example "Reading config loader"); name the file or function it is working on rather than a branch or a goal; one line, no quotes, no punctuation at the end, no markdown.',
	'Write the label in the predominant language of the notes below. A stray word or code token in another language does not change it, and neither does the language of these instructions.',
	'If a previous label is shown and the agent is still doing that, repeat it; otherwise say what is new.',
	'Use no tools. Reply with the label only.',
].join('\n')

/** One accepted line, or undefined when the reply cannot be used. */
export function validateLabel(reply: string): string | undefined {
	const trimmed = reply.trim()
	if (trimmed.length === 0 || trimmed.length > LABEL_MAX_CHARS) return undefined
	if (/[\r\n]/u.test(trimmed)) return undefined
	if (trimmed.startsWith('#') || trimmed.includes('```')) return undefined
	return trimmed
}

/** The request body for one label: the task, what the agent did lately, and the last label. */
export function labelPrompt(agent: SubagentActivity): string {
	const rows = agent.transcript
		.slice(-LABEL_CONTEXT_ROWS)
		.map((row) => {
			const who =
				row.kind === 'assistant'
					? 'agent'
					: row.kind === 'tool'
						? 'tool'
						: row.direction
							? 'message'
							: 'note'
			const text = row.kind === 'tool' && row.detail ? `${row.text} -> ${row.detail}` : row.text
			return `${who}: ${text.replace(/\s+/gu, ' ').slice(0, LABEL_ROW_CHARS)}`
		})
		.join('\n')
	return [
		`Task given to the agent:\n${agent.prompt.slice(0, 1500)}`,
		`What it has done so far (oldest first):\n${rows}`,
		agent.summary ? `Previous label: ${agent.summary}` : 'No previous label.',
	].join('\n\n')
}

/** How many messages the agent's own conversation holds, as far as the display knows. */
function messageCount(agent: SubagentActivity): number {
	return 1 + agent.transcript.length
}

/** Changes whenever the transcript does, cheaply. */
function signature(agent: SubagentActivity): string {
	const last = agent.transcript.at(-1)
	return `${agent.transcript.length}:${last?.id ?? ''}:${last && 'text' in last ? last.text.length : 0}`
}

/** What the host supplies: one tool-less request on the agent's own model. */
export type AskForLabel = (
	agent: SubagentActivity,
	instruction: string,
	body: string,
	signal: AbortSignal,
) => Promise<{ readonly text: string } | undefined>

export interface ActivityLabeler {
	stop(): void
}

export function startActivityLabeler(options: {
	readonly activity: SubagentActivityMonitor
	readonly ask: AskForLabel
	readonly intervalMs?: number
}): ActivityLabeler {
	const seen = new Map<string, string>()
	const inFlight = new Map<string, AbortController>()
	const tick = (): void => {
		const live = new Set<string>()
		for (const agent of options.activity.getSnapshot()) {
			const running = agent.status === 'working' || agent.status === 'queued'
			if (!running) continue
			live.add(agent.viewId)
			if (agent.background !== true || agent.replayed === true) continue
			if (agent.workflowRunId !== undefined) continue
			if (messageCount(agent) < LABEL_MIN_MESSAGES) continue
			if (inFlight.has(agent.viewId)) continue
			const sig = signature(agent)
			if (seen.get(agent.viewId) === sig) continue
			seen.set(agent.viewId, sig)
			const controller = new AbortController()
			inFlight.set(agent.viewId, controller)
			void options
				.ask(agent, LABEL_INSTRUCTION, labelPrompt(agent), controller.signal)
				.then((reply) => {
					if (!reply || controller.signal.aborted) return
					const label = validateLabel(reply.text)
					if (label) options.activity.setSummary(agent.viewId, label)
				})
				.catch(() => undefined)
				.finally(() => {
					inFlight.delete(agent.viewId)
				})
		}
		// An agent that ended takes its pending request and its memory with it.
		for (const [id, controller] of inFlight) {
			if (!live.has(id)) controller.abort()
		}
		for (const id of seen.keys()) if (!live.has(id)) seen.delete(id)
	}
	const timer = setInterval(tick, options.intervalMs ?? LABEL_INTERVAL_MS)
	timer.unref?.()
	return {
		stop() {
			clearInterval(timer)
			for (const controller of inFlight.values()) controller.abort()
			inFlight.clear()
		},
	}
}
