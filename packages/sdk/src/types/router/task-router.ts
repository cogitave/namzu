export type TaskType =
	| 'compaction'
	| 'summarization'
	| 'exploration'
	| 'coding'
	| 'verification'
	| 'planning'
	| 'advisory'
	| 'default'

/**
 * Send a particular kind of work to a particular model.
 *
 * **Which keys the runtime consults today: `compaction`, and `default` as its
 * fallback.** That is stated because the rest are silently inert, and an
 * inert key is worse than an absent one — a host who sets `coding` reads it
 * as taking effect. The compaction summary is the call worth routing first
 * regardless: it is the only model call a run makes that nobody asked for,
 * it reads a transcript and writes a summary, and it fires on exactly the
 * long runs where the primary model costs the most.
 *
 * The remaining keys describe sub-agent routing. `SupervisorAgent` already
 * threads this config down to the agent factory, but nothing classifies a
 * spawned task as exploration or coding, and guessing a classifier here
 * would put a wrong model behind a right-looking config.
 *
 * `advisory` is deliberately not consulted: an advisor carries its own
 * `model`, so routing would override an explicit choice with a general one.
 */
export interface TaskRouterConfig {
	readonly compaction?: string | null
	readonly summarization?: string | null
	readonly exploration?: string | null
	readonly coding?: string | null
	readonly verification?: string | null
	readonly planning?: string | null
	readonly advisory?: string | null
	readonly default?: string | null
}
