/**
 * Running a program the MODEL wrote.
 *
 * A model that can write a loop can do in one call what currently costs
 * twenty: filter a list, retry with backoff, fan out over files. Every one
 * of those is a control-flow shape the tool loop expresses by taking a full
 * model turn per step, at full context size, with the whole conversation
 * resent each time.
 *
 * The problem is that the program is untrusted text. It is not "code the
 * operator installed" — it is a string the model produced, possibly under
 * the influence of a web page it was told to summarise. So the seam is
 * defined here in terms of what a backend must GUARANTEE rather than what
 * it may offer, and the guarantees are the interesting part:
 *
 *  - **No ambient capability.** The program gets what the host passes and
 *    nothing else: no filesystem, no network, no process, no `require`. A
 *    backend that cannot withhold those is not a backend for this.
 *  - **Everything it can do, it does by asking.** The only channel out is a
 *    call back into the host, which is what makes NZ-EXEC-06's dispatch
 *    through the run's own `ToolRegistry` possible — the program cannot
 *    reach a tool the run did not grant, because it cannot reach anything.
 *  - **Bounded.** Wall clock and output, both enforced by the backend
 *    rather than requested of the program.
 *
 * `internal and unexported` is the task's own wording and is kept: a seam
 * with one backend and no consumer is a guess at what a consumer needs.
 * NZ-EXEC-06 is the consumer, and the surface joins the public API in the
 * commit that has one.
 */

/** A call the program made back into the host. */
export interface HostCallRequest {
	/** Which capability, by the name the host offered. */
	readonly name: string
	readonly input: unknown
}

export interface HostCallResult {
	readonly ok: boolean
	readonly value?: unknown
	readonly error?: string
}

/** Authority and provenance for one call from a running program. */
export interface HostCallContext {
	/** Unique within this program execution. */
	readonly runtimeToolCallId: string
	/**
	 * Revoked when the caller cancels or the program's own wall clock expires.
	 * A conforming host threads this into the operation it starts.
	 */
	readonly signal: AbortSignal
}

/**
 * What the host will answer.
 *
 * A function rather than a table, so the host decides per call. NZ-EXEC-06
 * makes this the run's `ToolRegistry` and its permission gate, which is
 * exactly the point: the program's reach is the run's reach, resolved at
 * the moment of the call rather than frozen when the program started.
 */
export type HostCallHandler = (
	request: HostCallRequest,
	context: HostCallContext,
) => Promise<HostCallResult>

export interface RunCodeOptions {
	/** The program. Untrusted text, from the model. */
	readonly source: string
	/** Names the program may call. Anything else is refused by the backend. */
	readonly allowedCalls: readonly string[]
	readonly onHostCall: HostCallHandler
	/** Hard wall clock. Enforced by the backend, not asked of the program. */
	readonly timeoutMs: number
	/**
	 * Cap on what the program may print.
	 *
	 * Enforced, and truncation is REPORTED. A program whose output was cut
	 * silently is a model reading a partial answer as a whole one — the same
	 * rule the tool-output cap and the background-job buffer already follow.
	 */
	readonly maxOutputBytes: number
	readonly signal?: AbortSignal
}

export type CodeRunOutcome =
	| { readonly status: 'completed'; readonly result: unknown }
	| { readonly status: 'failed'; readonly error: string }
	| { readonly status: 'timed-out' }
	| { readonly status: 'cancelled' }

export interface CodeRunResult {
	readonly outcome: CodeRunOutcome
	/** Whatever the program printed, in order. */
	readonly output: string
	readonly outputTruncated: boolean
	/** Every host call it made, in order, with what it got back. */
	readonly calls: readonly {
		readonly name: string
		readonly ok: boolean
	}[]
}

/**
 * A backend that can run one of these.
 *
 * One method, deliberately. A backend with a `prepare`/`run`/`dispose`
 * lifecycle invites a caller to reuse an instance across programs, and two
 * model-authored programs sharing a runtime share whatever the first one
 * left in it.
 */
export interface CodeRuntime {
	readonly id: string
	run(options: RunCodeOptions): Promise<CodeRunResult>
}

/** A program that asked for a capability it was not granted. */
export class HostCallDeniedError extends Error {
	readonly details: { name: string; allowed: readonly string[] }

	constructor(details: { name: string; allowed: readonly string[] }) {
		super(
			`The program called "${details.name}", which it was not granted. Available: ${details.allowed.length > 0 ? details.allowed.join(', ') : '(none)'}`,
		)
		this.name = 'HostCallDeniedError'
		this.details = details
	}
}
