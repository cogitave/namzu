import type { SessionId, TurnId } from '../ids/index.js'

/**
 * What a turn learned, offered to whoever decides what is worth keeping.
 *
 * namzu could store a memory and could not *form* one. `MemoryStore` and
 * its disk implementation have been here all along, and the only path
 * into them is the model calling `save_memory` — so a turn that worked out
 * a durable fact and never thought to write it down lost it at settle,
 * along with everything the compaction pass had already extracted and
 * structured on the way.
 *
 * The extraction is the part that was already built: the compaction pass
 * distils the transcript into decisions, discoveries, constraints and
 * failures precisely because a summary of prose is worth less than a list
 * of facts. That structure was serialized into one system message and
 * then dropped on the floor when the turn ended.
 */
export interface SessionMemoryCandidate {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/** What the turn was asked to do, as the extractor recorded it. */
	readonly task: string
	/** Choices the turn made and did not revisit. */
	readonly decisions: readonly string[]
	/** Things it found out — the shape of a codebase, the name of a table. */
	readonly discoveries: readonly string[]
	/** What the user said must hold. The most durable category of the four. */
	readonly userRequirements: readonly string[]
	/** Approaches that failed, so a later run does not pay for them again. */
	readonly failures: readonly string[]
	/** Facts about the machine, the toolchain, the environment. */
	readonly environment: readonly string[]
	/** Files the turn touched, by path. */
	readonly files: readonly string[]
	/**
	 * How many entries each capped list dropped during the turn.
	 *
	 * Carried rather than hidden: a host deciding whether this is worth
	 * storing should know it is looking at a truncated record.
	 */
	readonly evicted: Readonly<Record<string, number>>
}

/**
 * Decide what a finished run should leave behind.
 *
 * Called once, when the turn settles, with everything the compaction pass
 * extracted. Deliberately a callback rather than a store the runtime
 * writes into: what is worth remembering is a policy question the host
 * owns, and a runtime that decided it would be writing a row for every
 * run whether or not anything happened.
 *
 * Never blocks and never fails the turn. It runs after the answer is
 * settled, so a throw is logged and swallowed — a memory that failed to
 * form must not retract an answer that was already produced. A host that
 * needs the write to be part of the turn's success should do it in its own
 * code, where it can fail loudly.
 */
export type PromoteMemory = (candidate: SessionMemoryCandidate) => void | Promise<void>

/**
 * Project the compaction pass's working state into a promotion candidate.
 *
 * A projection rather than the state itself, for the same reason the
 * plugin hooks got one: the working state is an internal structure with
 * caps, eviction counters and slot objects that exist to serve
 * compaction, and handing it over would make every future field of it
 * part of a host-facing contract by accident.
 */
export function toMemoryCandidate(
	sessionId: SessionId,
	turnId: TurnId,
	state: {
		task: string
		decisions: string[]
		discoveries: string[]
		userRequirements: string[]
		failures: string[]
		environment: string[]
		files: Map<string, unknown>
		evicted: Record<string, number>
	},
): SessionMemoryCandidate {
	return {
		sessionId,
		turnId,
		task: state.task,
		decisions: [...state.decisions],
		discoveries: [...state.discoveries],
		userRequirements: [...state.userRequirements],
		failures: [...state.failures],
		environment: [...state.environment],
		files: [...state.files.keys()],
		evicted: { ...state.evicted },
	}
}

/**
 * The candidate for this turn, or `undefined` when there is nothing to
 * offer.
 *
 * A separate function because "was anything extracted?" is a decision,
 * and a decision inlined into a `try` is one a test cannot tell apart
 * from the catch that swallows its failure. Without an extractor there
 * is no working state, and inventing an empty candidate would ask a host
 * to store a record of nothing.
 */
export function memoryCandidateFor(
	sessionId: SessionId,
	turnId: TurnId,
	manager: { getState(): Parameters<typeof toMemoryCandidate>[2] } | undefined,
): SessionMemoryCandidate | undefined {
	if (!manager) return undefined
	return toMemoryCandidate(sessionId, turnId, manager.getState())
}
