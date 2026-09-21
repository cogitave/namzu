/**
 * Tool calls a turn already executed, recovered from the session log.
 *
 * A batch's results reach the message history only once the WHOLE batch
 * settles, so a hard kill part-way through loses every result that had
 * already come back, and a resumed turn would re-execute those calls. For a
 * file write that is waste; for a payment or an email it is a second one.
 * These shapes are what the resume path reads to avoid that.
 */

/** One finished tool call, recovered from the session log. */
export interface CompletedToolRecord {
	readonly toolUseId: string
	readonly toolName: string
	readonly result: string
	readonly isError: boolean
}

/** The latest recorded execution boundary of a tool call, not its inferred external effect. */
export type ToolExecutionRecord =
	| (CompletedToolRecord & { readonly status: 'completed' })
	| { readonly toolUseId: string; readonly toolName: string; readonly status: 'started' }

/**
 * Absence proves no recorded start only when the whole selected log is
 * complete. A started call without a completion has an unknown outcome and
 * must not be replayed automatically.
 */
export interface ToolExecutionSnapshot {
	readonly complete: boolean
	readonly records: ReadonlyMap<string, ToolExecutionRecord>
}
