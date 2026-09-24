/**
 * The tool calls of one scheduled run that did not do what they were for:
 * refused (they never ran — a gate rule, the scheduled-run floor, the mode, a
 * declined review) and failed (they ran and returned an error).
 *
 * A run ends `completed` when its turn ends normally, whatever its calls
 * did: a run whose only command the floor refused ended `completed`, and its
 * notification said `finished`. How the turn ended stays the status, and the
 * counts with each kind's first reason travel beside it, in the run's
 * result, its history record, the job's state and its notification.
 */

import { sanitizeLine } from '../../integrations/notifications/desktop/sanitize.js'
import type { ScheduleCallTally } from '../types.js'

/** What the kernel writes in place of a result for a call that never ran (`deniedToolOutput`). */
const NOT_EXECUTED = /^Error: Tool "[^"]*" was not executed\.\s*/
/**
 * What the kernel writes for a call to a tool the session does not have, in
 * each of its forms: `Error: Unknown tool "x"`, followed by `. Available: …`
 * (what the step can call) when the registry says it lacks the name, and
 * `Error: Unknown or unavailable tool "x": …` from a direct call.
 */
const UNKNOWN_TOOL = /^Error: Unknown (?:or unavailable )?tool "/
/** The gate's prefix, which says nothing the word "refused" does not. */
const GATE = /^Blocked by the authorization gate:\s*/
/** How long a recorded reason may be. */
export const CALL_REASON_MAX = 300

export interface CallEnd {
	readonly toolName: string
	readonly isError: boolean
	readonly output?: string
	readonly summary: string
	/** The person declined on the tool's own screen: nothing failed. */
	readonly cancelled?: boolean
}

export interface CallTallies {
	readonly refusedCalls?: ScheduleCallTally
	readonly failedCalls?: ScheduleCallTally
}

export class CallTally {
	#refused = 0
	#failed = 0
	#firstRefused: ScheduleCallTally['first'] | undefined
	#firstFailed: ScheduleCallTally['first'] | undefined
	readonly #withheld: ReadonlySet<string>

	/**
	 * `withheld`: the tools the run was not given because its permissions
	 * never let it use them. A call to one comes back as an unknown tool, and
	 * is a refusal, not a failure.
	 */
	constructor(withheld: Iterable<string> = []) {
		this.#withheld = new Set(withheld)
	}

	/** Count one finished call. */
	observe(call: CallEnd): void {
		if (!call.isError || call.cancelled) return
		const text = call.output ?? call.summary
		const refused = NOT_EXECUTED.exec(text)
		if (refused) {
			this.#refused++
			this.#firstRefused ??= {
				tool: call.toolName,
				reason: sanitizeLine(text.slice(refused[0].length).replace(GATE, ''), CALL_REASON_MAX),
			}
			return
		}
		if (this.#withheld.has(call.toolName) && UNKNOWN_TOOL.test(text)) {
			this.#refused++
			this.#firstRefused ??= {
				tool: call.toolName,
				reason: `the job's permissions never let a run use ${call.toolName}, so the run was not given it`,
			}
			return
		}
		this.#failed++
		this.#firstFailed ??= {
			tool: call.toolName,
			reason: sanitizeLine(
				text
					.replace(/^Error:\s*/, '')
					.split(/\r?\n/)
					.find((line) => line.trim().length > 0) ?? '',
				CALL_REASON_MAX,
			),
		}
	}

	/** The counts so far, each only when above zero. */
	tallies(): CallTallies {
		return {
			...(this.#refused > 0 && this.#firstRefused
				? { refusedCalls: { count: this.#refused, first: this.#firstRefused } }
				: {}),
			...(this.#failed > 0 && this.#firstFailed
				? { failedCalls: { count: this.#failed, first: this.#firstFailed } }
				: {}),
		}
	}
}

/** `1 call was refused (bash: <reason>); 2 calls failed (read: <reason>)`, or nothing. */
export function callsLine(result: CallTallies): string {
	return [
		...(result.refusedCalls
			? [
					`${callsWords(result.refusedCalls, 'refused')} (${result.refusedCalls.first.tool}: ${result.refusedCalls.first.reason})`,
				]
			: []),
		...(result.failedCalls
			? [
					`${callsWords(result.failedCalls, 'failed')} (${result.failedCalls.first.tool}: ${result.failedCalls.first.reason})`,
				]
			: []),
	].join('; ')
}

/** `1 call refused, 2 failed` for a job's last run, from its state's counts, or nothing. */
export function callsCount(last: {
	readonly refusedCalls?: number
	readonly failedCalls?: number
}): string {
	const refused = last.refusedCalls ?? 0
	const failed = last.failedCalls ?? 0
	const calls = (n: number) => `${n} call${n === 1 ? '' : 's'}`
	if (refused > 0) return `${calls(refused)} refused${failed > 0 ? `, ${failed} failed` : ''}`
	return failed > 0 ? `${calls(failed)} failed` : ''
}

/** `1 call was refused`, `2 calls failed`: a count in words. */
export function callsWords(tally: ScheduleCallTally, verb: 'refused' | 'failed'): string {
	const n = tally.count
	return verb === 'refused'
		? `${n} call${n === 1 ? ' was' : 's were'} refused`
		: `${n} call${n === 1 ? '' : 's'} failed`
}
