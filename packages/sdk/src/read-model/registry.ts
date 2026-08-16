import type { PersistedRunEvent } from '../types/run/index.js'

/**
 * A derived value maintained incrementally from the run's event log.
 *
 * Everything derived from a run was computed by scanning what was in hand
 * at the moment somebody asked — `deriveRunStatus` takes a status and a
 * park and answers about that instant. That works while the whole run fits
 * in memory and stops working the moment it does not: a caller wanting the
 * status of a run whose history has been compacted, or of a run in another
 * process, has to load the log and fold it, and every caller folds it
 * slightly differently.
 *
 * A read model is that fold, written once and advanced one event at a time.
 * The registry below is what makes "advanced one event at a time" a
 * property rather than a hope: it refuses a duplicate and refuses a gap, so
 * a projection is either correct or absent, never quietly built on a log it
 * did not fully see.
 */

export interface ReadModel<TState> {
	/** Stable, and how a caller asks for this projection's state. */
	readonly id: string
	/** The value before any event. Called once per registry. */
	initial(): TState
	/**
	 * PURE. Same state plus same event must give the same result, every
	 * time and in any process.
	 *
	 * Returning the SAME object when an event changes nothing is expected
	 * and cheap; the registry does not compare, and a model that allocated
	 * a fresh state per event would still be correct, only wasteful.
	 */
	apply(state: TState, event: PersistedRunEvent): TState
}

/** An event the registry has already folded in. */
export class DuplicateEventError extends Error {
	readonly details: { seq: number; lastSeq: number }

	constructor(details: { seq: number; lastSeq: number }) {
		super(`Event seq=${details.seq} was already applied (the registry is at ${details.lastSeq}).`)
		this.name = 'DuplicateEventError'
		this.details = details
	}
}

/** An event that skips one the registry never saw. */
export class EventGapError extends Error {
	readonly details: { seq: number; expected: number }

	constructor(details: { seq: number; expected: number }) {
		super(
			`Event seq=${details.seq} arrived while the registry expected ${details.expected}; a projection built across a gap is wrong in a way nothing reports.`,
		)
		this.name = 'EventGapError'
		this.details = details
	}
}

/** A projection nobody registered. */
export class UnknownReadModelError extends Error {
	readonly details: { id: string }

	constructor(details: { id: string }) {
		super(`No read model registered as "${details.id}".`)
		this.name = 'UnknownReadModelError'
		this.details = details
	}
}

/** Two models claiming one id. */
export class ReadModelCollisionError extends Error {
	readonly details: { id: string }

	constructor(details: { id: string }) {
		super(`A read model with id "${details.id}" is already registered.`)
		this.name = 'ReadModelCollisionError'
		this.details = details
	}
}

/**
 * Every projection of one run, advanced together.
 *
 * Together, and that is the design: a registry per run rather than per
 * model, so `lastSeq` is one number and a caller reading two projections
 * cannot be handed states derived from different prefixes of the same log.
 */
export class ReadModelRegistry {
	private readonly models = new Map<string, ReadModel<unknown>>()
	private readonly states = new Map<string, unknown>()
	private seq = 0

	/** The seq this registry has folded up to. `0` before any event. */
	get lastSeq(): number {
		return this.seq
	}

	register<TState>(model: ReadModel<TState>): void {
		if (this.models.has(model.id)) throw new ReadModelCollisionError({ id: model.id })
		this.models.set(model.id, model as ReadModel<unknown>)
		this.states.set(model.id, model.initial())
	}

	/**
	 * Fold one event into every projection.
	 *
	 * REFUSES a duplicate and REFUSES a gap. Both are silent corruptions
	 * otherwise: a duplicate double-counts anything a model accumulates, and
	 * a gap produces a state that looks complete and describes a log the
	 * registry never saw. A caller that legitimately has to skip ahead
	 * rebuilds with {@link replay} instead, which is honest about starting
	 * over.
	 */
	apply(event: PersistedRunEvent): void {
		if (event.seq <= this.seq) {
			throw new DuplicateEventError({ seq: event.seq, lastSeq: this.seq })
		}
		if (event.seq !== this.seq + 1) {
			throw new EventGapError({ seq: event.seq, expected: this.seq + 1 })
		}
		for (const [id, model] of this.models) {
			this.states.set(id, model.apply(this.states.get(id), event))
		}
		this.seq = event.seq
	}

	/**
	 * Throw away every state and fold the whole log again.
	 *
	 * The honest alternative to accepting a gap. A caller that has lost its
	 * place, or that just registered a model into a running registry, gets a
	 * correct answer by paying for the whole log rather than a plausible one
	 * by pretending it did not miss anything.
	 */
	replay(events: readonly PersistedRunEvent[]): void {
		for (const [id, model] of this.models) this.states.set(id, model.initial())
		this.seq = 0
		for (const event of events) this.apply(event)
	}

	/** The projection's state, or throw for an id nobody registered. */
	get<TState>(id: string): TState {
		if (!this.models.has(id)) throw new UnknownReadModelError({ id })
		return this.states.get(id) as TState
	}

	has(id: string): boolean {
		return this.models.has(id)
	}
}
