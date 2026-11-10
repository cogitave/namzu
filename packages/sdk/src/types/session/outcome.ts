import { z } from 'zod'

/**
 * How a turn came out, from the kernel's own record of its tool calls.
 *
 * `checked` says a recognised check passed on the workspace as the turn left
 * it. It does not say the check covers the change.
 */
export type TurnOutcomeVerdict =
	/** Nothing in the workspace differs from the start of the turn. */
	| 'unchanged'
	/** Changed; at least one check passed on the final state and none is left failing. */
	| 'checked'
	/** Changed; checks passed, but the workspace changed again after the last pass. */
	| 'stale'
	/** Some check's latest run did not pass. Changed or not. */
	| 'failing'
	/** Changed; checks ran but none established a pass (status hidden, background, timed out, or unknown freshness). */
	| 'inconclusive'
	/** Changed; no check ran. */
	| 'unchecked'

/** What one check established. */
export type TurnOutcomeCheckResult =
	/** Exit status 0, and the status is the check's own. */
	| 'passed'
	/** Non-zero exit, refused, or errored. */
	| 'failed'
	/** The command line lets something else decide the exit status: a pipe, `;`, `||`, a trailing `&`. */
	| 'masked'
	/** Handed to a background job, continued, timed out, or its status was never seen. */
	| 'unsettled'

export interface TurnOutcomeCheck {
	/** As run, clipped. */
	readonly command: string
	/** The loop step the latest run of this command finished in. */
	readonly step: number
	readonly result: TurnOutcomeCheckResult
	readonly exitCode?: number
	/**
	 * True when the workspace is the same now as when this check finished. False
	 * when it is known to have changed since. Absent when that cannot be told.
	 */
	readonly fresh?: boolean
}

export interface TurnOutcome {
	readonly verdict: TurnOutcomeVerdict
	/**
	 * How the workspace was observed. `calls`: only the kernel's own write tools
	 * were seen, so a change made by a shell command or another tool is invisible
	 * and `unchanged` means only that no write tool ran. `workspace`: the host
	 * supplied a change detector and the start, each check and the end were
	 * compared with it.
	 */
	readonly basis: 'calls' | 'workspace'
	readonly changes: {
		/** Distinct paths the turn's write tools changed. */
		readonly total: number
		/** The first of them, bounded. */
		readonly paths: readonly string[]
		/** The workspace moved and no write tool call explains it. */
		readonly outsideKnownTools: boolean
	}
	/** In order of first run; the latest run of each distinct command; bounded. */
	readonly checks: readonly TurnOutcomeCheck[]
	/** How many distinct checks ran, when `checks` was cut. */
	readonly checksTotal?: number
}

/** Host hooks for the turn's outcome record. */
export interface TurnOutcomeConfig {
	/**
	 * A fingerprint of the workspace, or `null` when it cannot be told.
	 * `fingerprintWorkspace` is the kernel's own. `null` is never a match.
	 * Called before the first call of the turn that could change the workspace,
	 * after each check, and once when the turn ends; never in a turn whose calls
	 * are all provably read-only.
	 */
	readonly detectChanges?: () => Promise<string | null>
	/** Names a command that checks work, beyond the ones the kernel recognises. */
	readonly isCheck?: (command: string) => boolean
	/** Deadline per detector call. A detector that is late is `null`. Default 3000. */
	readonly detectTimeoutMs?: number
}

/** Bounds on a recorded outcome. */
export const OUTCOME_MAX_PATHS = 50
export const OUTCOME_MAX_CHECKS = 20
export const OUTCOME_MAX_COMMAND_CHARS = 300
export const OUTCOME_MAX_PATH_CHARS = 300
export const OUTCOME_DEFAULT_DETECT_TIMEOUT_MS = 3000

const verdict = z.enum(['unchanged', 'checked', 'stale', 'failing', 'inconclusive', 'unchecked'])
const count = z.number().int().nonnegative().safe()

/** The shape a recorded outcome must have to be written to, or read back from, the session log. */
export const TurnOutcomeSchema = z
	.object({
		verdict,
		basis: z.enum(['calls', 'workspace']),
		changes: z
			.object({
				total: count,
				paths: z.array(z.string().max(OUTCOME_MAX_PATH_CHARS)).max(OUTCOME_MAX_PATHS),
				outsideKnownTools: z.boolean(),
			})
			.strict(),
		checks: z
			.array(
				z
					.object({
						command: z.string().max(OUTCOME_MAX_COMMAND_CHARS + 1),
						step: count,
						result: z.enum(['passed', 'failed', 'masked', 'unsettled']),
						exitCode: z.number().int().safe().optional(),
						fresh: z.boolean().optional(),
					})
					.strict(),
			)
			.max(OUTCOME_MAX_CHECKS),
		checksTotal: count.optional(),
	})
	.strict()
