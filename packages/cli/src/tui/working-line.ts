/**
 * What the working line says, as plain functions: the mark before the word, the
 * word (the phase the kernel knows the turn is in), the figures after it, and
 * what a silent stretch is called.
 *
 * Kept apart from the component so each rule can be tested without a terminal,
 * and so the words are chosen in one place: the kernel's own plain voice, a
 * phase named only where the kernel actually knows it. Where it does not, the
 * word stays `Working` — a guess dressed as a phase would be worse than none.
 */

import { isTaskTool, taskCallLabel } from './task-activity.js'
import { formatCompactCount, formatElapsed } from './units.js'

/** The default word, when no phase is known. */
export const WORKING_WORD = 'Working'

/**
 * The mark's shapes, a slow loop: a disc that shrinks to a point and swells back. One
 * cell wide each. Under reduced motion, without colour or with a screen reader
 * it stays on {@link WORKING_MARK_STILL}.
 */
export const WORKING_MARK_FRAMES: readonly string[] = ['●', '•', '·', '•']
export const WORKING_MARK_STILL = '●'
/** Animation ticks (120 ms each) per shape: 0.48 s a step, a loop of about two seconds. */
const TICKS_PER_SHAPE = 4

export function workingMark(tick: number, animated: boolean): string {
	if (!animated) return WORKING_MARK_STILL
	const frame = Math.floor(Math.max(0, tick) / TICKS_PER_SHAPE) % WORKING_MARK_FRAMES.length
	return WORKING_MARK_FRAMES[frame] ?? WORKING_MARK_STILL
}

/** From this much of the turn on, the clock is on the line: from the second second, and then always. */
export const CLOCK_FROM_MS = 1_000
/** A reply that has not moved for this long is called quiet, in words. */
export const QUIET_FROM_MS = 10_000
/** Streaming counts as `writing` while the last token is this fresh. */
const WRITING_WINDOW_MS = 3_000

export interface PhaseInput {
	/** A word the host chose for a stretch that is not a reply (a compaction). Wins. */
	readonly activityLabel?: string | undefined
	/** A question for the person is up. */
	readonly waitingFor?: 'approval' | undefined
	/** The provider is being asked again after a failure. */
	readonly retrying: boolean
	/** Calls drawn as rows: their tool names, and whether each is a shell command or a wait on an agent. */
	readonly tools: readonly {
		readonly toolName?: string | undefined
		readonly shell: boolean
		readonly waitsOnAgent: boolean
	}[]
	/** Calls running in all, including the ones folded into a counted line. */
	readonly running: number
	/** The model is producing reasoning. */
	readonly thinking: boolean
	/** Tokens have arrived this turn. */
	readonly tokens: boolean
	/** Milliseconds since the reply last moved (a token, a reasoning line). */
	readonly sinceProgressMs: number
	/**
	 * Milliseconds since the last token, or Infinity when a call has run since.
	 * Absent means the same as `sinceProgressMs`.
	 */
	readonly sinceTokenMs?: number | undefined
}

/** The tool's own name, lower case, for `Running grep`. */
function plainToolName(toolName: string): string {
	if (toolName.startsWith('mcp__')) return 'a connector tool'
	return toolName.replace(/[_-]+/gu, ' ').toLowerCase()
}

/** The word on the working line for this moment. */
export function workingWord(input: PhaseInput): string {
	if (input.activityLabel) return input.activityLabel
	if (input.waitingFor === 'approval') return 'Waiting for your approval'
	if (input.retrying) return 'Retrying'
	if (input.running > 0) {
		const [only] = input.tools
		if (input.tools.length === 1 && input.running === 1 && only) {
			if (only.waitsOnAgent) return 'Waiting for an agent'
			if (only.shell) return 'Running a command'
			if (only.toolName !== undefined && isTaskTool(only.toolName))
				return taskCallLabel(only.toolName)
			return only.toolName ? `Running ${plainToolName(only.toolName)}` : 'Running a tool'
		}
		if (input.tools.length > 0 && input.tools.every((tool) => tool.waitsOnAgent))
			return 'Waiting for agents'
		return `Running ${input.running} tools`
	}
	if (input.thinking) return 'Thinking'
	if (input.tokens && (input.sinceTokenMs ?? input.sinceProgressMs) < WRITING_WINDOW_MS)
		return 'Writing'
	if (input.sinceProgressMs >= WRITING_WINDOW_MS) return 'Waiting for the model'
	return WORKING_WORD
}

export interface FiguresInput {
	readonly elapsedMs: number
	readonly tokens?: number | undefined
	readonly agents: number
	/**
	 * How long nothing has arrived, when that is the model's silence: not while
	 * it is known to be thinking, a call is running, a compaction runs, or the
	 * provider is being retried (each of those has its own words).
	 */
	readonly quietMs?: number | undefined
	/** Tokens have arrived this turn, so a quiet that began near the start is not `no reply yet`. */
	readonly replied?: boolean | undefined
}

/**
 * The figures in parentheses after the word, or `''` before the clock's
 * moment. The clock is first and, once on, always there; the quiet note says so
 * in words and for how long (`no reply for 24s`, or `no reply yet` when nothing has come
 * since the turn began, which the clock beside it already measures); colour on the word only ever backs it up.
 */
export function workingFigures(input: FiguresInput): string {
	const parts: string[] = []
	if (input.elapsedMs >= CLOCK_FROM_MS) parts.push(formatElapsed(input.elapsedMs))
	if (input.quietMs !== undefined && input.quietMs >= QUIET_FROM_MS && parts.length > 0) {
		// Nothing has come since the turn began: the clock already says for how long.
		const sinceStart = input.replied !== true && input.quietMs >= input.elapsedMs - 1_500
		parts.push(sinceStart ? 'no reply yet' : `no reply for ${formatElapsed(input.quietMs)}`)
	}
	if (input.tokens !== undefined && input.tokens > 0)
		parts.push(`↓ ${formatCompactCount(input.tokens)} tokens`)
	if (input.agents > 0)
		parts.push(`${input.agents} agent${input.agents === 1 ? '' : 's'} · ↓ to view`)
	if (parts.length === 0) return ''
	return `(${parts.join(' · ')})`
}
