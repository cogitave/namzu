import { z } from 'zod'
import type { ToolDefinition } from '../../types/tool/index.js'
import type { ToolCallView, ToolResultView } from '../../types/tool/presentation.js'
import { defineTool } from '../defineTool.js'
import type { SelfPacedHost, SessionTimerHost } from './types.js'

export const TIMER_SET_TOOL_NAME = 'timer_set'
export const TIMER_LIST_TOOL_NAME = 'timer_list'
export const TIMER_CANCEL_TOOL_NAME = 'timer_cancel'
export const WAKE_UP_TOOL_NAME = 'wake_up'

/** A self-paced wake-up is never sooner than this many seconds away. */
export const WAKE_UP_MIN_SECONDS = 60
/** A self-paced wake-up is never later than this many seconds away. */
export const WAKE_UP_MAX_SECONDS = 3600

/**
 * The delay a wake-up really gets: rounded to a whole second and held between
 * a minute and an hour. Not a number counts as the shortest, infinity as the
 * longest.
 */
export function clampWakeUpDelay(requested: number): { seconds: number; clamped: boolean } {
	let rounded: number
	if (Number.isNaN(requested)) rounded = WAKE_UP_MIN_SECONDS
	else if (requested === Number.POSITIVE_INFINITY) rounded = WAKE_UP_MAX_SECONDS
	else if (requested === Number.NEGATIVE_INFINITY) rounded = WAKE_UP_MIN_SECONDS
	else rounded = Math.round(requested)
	const seconds = Math.max(WAKE_UP_MIN_SECONDS, Math.min(WAKE_UP_MAX_SECONDS, rounded))
	return { seconds, clamped: !Number.isFinite(requested) || rounded !== seconds }
}

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

function failureOrHidden(result: { success: boolean; error?: string }): ToolResultView {
	if (!result.success) return { kind: 'generic', label: oneLine(result.error) || 'Not done' }
	return HIDDEN
}

function clock(iso: string): string {
	const d = new Date(iso)
	const two = (n: number) => String(n).padStart(2, '0')
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

const timerSetSchema = z.object({
	when: z
		.string()
		.describe(
			'when it fires: "10m" or "every 10m" (interval, at least a minute), "in 10m" or "at 14:30" (once), or a five-field cron expression in local time',
		),
	prompt: z
		.string()
		.min(1)
		.max(4_000)
		.describe('the message sent to this conversation each time it fires'),
	recurring: z
		.boolean()
		.optional()
		.describe(
			'true (default) fires every time `when` comes round until cancelled or after 7 days; false fires once at the next match, then is removed',
		),
})

const timerCancelSchema = z.object({
	id: z.string().describe('the timer id timer_set returned'),
})

const wakeUpSchema = z.object({
	delay_seconds: z
		.number()
		.optional()
		.describe(
			'seconds until the next wake-up, held between 60 and 3600; required unless stop is true',
		),
	reason: z
		.string()
		.optional()
		.describe(
			'one short sentence on why that delay, shown to the person; required unless stop is true',
		),
	quiet: z
		.boolean()
		.optional()
		.describe(
			'true when nothing changed this tick (checked, nothing to report); false when something happened. Runs of quiet ticks are folded on screen',
		),
	stop: z
		.boolean()
		.optional()
		.describe('true ends the self-paced loop now; every other field is then ignored'),
})

/**
 * `timer_set`, `timer_list`, `timer_cancel`: prompts the model sets to fire
 * into THIS conversation once or on a schedule, in memory only.
 *
 * Unlike `session_loop` they need no review: a timer lives only while the
 * session is open, is never written to the durable schedule store, fires only
 * when the conversation is idle (queued behind a running turn), and is shown to
 * the person when it fires.
 */
export function buildSessionTimerTools(host: SessionTimerHost): ToolDefinition[] {
	return [
		defineTool({
			name: TIMER_SET_TOOL_NAME,
			description:
				'Set a timer that sends a prompt to this conversation later: once ("remind me at 3pm") or on a schedule. It lives only while this session is open, fires only between turns, and recurring timers end after 7 days. A recurring timer may fire a little late, by at most half its interval and never more than 30 minutes; pick a minute other than :00 and :30 when the time is not fixed. At most 50 timers. For work that must survive closing Namzu use schedule; to repeat on the user\'s request use session_loop.',
			inputSchema: timerSetSchema,
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			presentCall: (input: { when?: unknown; prompt?: unknown }) =>
				activity(`Timer ${oneLine(input.when)} · ${oneLine(input.prompt)}`),
			presentResult: (_input: unknown, result) => failureOrHidden(result),
			async execute(input) {
				try {
					const timer = await host.create({
						when: input.when,
						prompt: input.prompt,
						recurring: input.recurring ?? true,
					})
					const next = timer.nextFireAt ? ` Next run: ${clock(timer.nextFireAt)}.` : ''
					return {
						success: true,
						output: timer.recurring
							? `Timer ${timer.id} set (${timer.schedule}).${next} Session-only; it ends after 7 days. timer_cancel ${timer.id} stops it sooner.`
							: `Timer ${timer.id} set (${timer.schedule}).${next} Session-only; it fires once, then is removed.`,
						data: { id: timer.id },
					}
				} catch (error) {
					return {
						success: false,
						output: '',
						error: error instanceof Error ? error.message : String(error),
					}
				}
			},
		}),
		defineTool({
			name: TIMER_LIST_TOOL_NAME,
			description: "List this session's timers with when each next fires.",
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			presentCall: () => activity('List timers'),
			presentResult: (_input: unknown, result) => failureOrHidden(result),
			async execute() {
				const timers = host.list()
				if (timers.length === 0) return { success: true, output: 'No timers.', data: { timers } }
				return {
					success: true,
					output: timers
						.map(
							(t) =>
								`${t.id} — ${t.schedule} (${t.recurring ? 'recurring' : 'once'})${t.nextFireAt ? `, next run ${clock(t.nextFireAt)}` : ''}: ${oneLine(t.prompt)}`,
						)
						.join('\n'),
					data: { timers },
				}
			},
		}),
		defineTool({
			name: TIMER_CANCEL_TOOL_NAME,
			description: 'Cancel a timer set with timer_set, by its id.',
			inputSchema: timerCancelSchema,
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: false,
			presentCall: () => activity('Cancel timer'),
			presentResult: (_input: unknown, result) => failureOrHidden(result),
			async execute(input) {
				const stopped = await host.cancel(input.id)
				return stopped
					? { success: true, output: `Cancelled timer ${input.id}.` }
					: { success: false, output: '', error: `No timer has id "${input.id}".` }
			},
		}),
	]
}

/**
 * `wake_up`: how the model paces a self-paced loop. Each tick it says when to
 * wake next (a minute to an hour away), why, and whether anything changed, or
 * ends the loop. A tick that does not call it ends the loop.
 */
export function buildWakeUpTool(host: SelfPacedHost): ToolDefinition {
	return defineTool({
		name: WAKE_UP_TOOL_NAME,
		description:
			'Pace a self-paced loop (one started without an interval). Before ending each tick call it with delay_seconds (held between 60 and 3600), a short reason and quiet; with stop true it ends the loop. Do not poll background work with short waits: pick 1200 to 1800 seconds for idle ticks and wake sooner only for something specific. A tick that does not call it ends the loop.',
		inputSchema: wakeUpSchema,
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		presentCall: (input: { stop?: unknown; reason?: unknown }) =>
			input.stop === true
				? activity('End loop')
				: activity(`Next wake-up · ${oneLine(input.reason)}`),
		presentResult: (_input: unknown, result) => failureOrHidden(result),
		async execute(input) {
			if (input.stop === true) {
				const ended = host.stop()
				return ended === 0
					? { success: true, output: 'No self-paced loop is running; nothing to stop.' }
					: { success: true, output: 'Loop stopped. No further wake-ups are scheduled.' }
			}
			if (input.delay_seconds === undefined || !input.reason) {
				return {
					success: false,
					output: '',
					error: 'delay_seconds and reason are required unless stop is true.',
				}
			}
			try {
				const next = host.wakeUp({
					delaySeconds: input.delay_seconds,
					reason: input.reason,
					quiet: input.quiet === true,
				})
				const note = next.clamped
					? ` (held to ${next.delaySeconds}s from the ${Number.isFinite(input.delay_seconds) ? input.delay_seconds : 'unbounded'}s you asked for)`
					: ''
				return {
					success: true,
					output: `Next wake-up at ${clock(next.dueAt)} (in ${next.delaySeconds}s)${note}. End your turn now; the loop sends you the next tick then.`,
					data: { dueAt: next.dueAt, delaySeconds: next.delaySeconds },
				}
			} catch (error) {
				return {
					success: false,
					output: '',
					error: error instanceof Error ? error.message : String(error),
				}
			}
		},
	})
}
