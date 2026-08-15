import { ManagedRegistry } from '../registry/ManagedRegistry.js'

/**
 * What a module's check said about its own claim, the moment it was asked.
 *
 * Three states, not two, for the same reason {@link InvariantOutcome} shares
 * its shape with NZ-BOOT-02's `CapabilityProbe`: a check that could not run
 * — no live run to point it at, a dependency not wired yet — is not the same
 * fact as a check that ran and found nothing wrong, and collapsing the two
 * turns "I do not know" into the strongest possible wrong answer. See
 * `docs/conventions/an-optional-dependency-may-not-degrade-a-check.md`.
 */
export type InvariantOutcome =
	| { readonly state: 'holds' }
	| { readonly state: 'violated'; readonly detail: string }
	| { readonly state: 'unknown'; readonly reason: string }

/**
 * A module's claim about its own live state, as a function of whatever
 * context evaluating it needs.
 *
 * Stored on the registry as `InvariantCheck<never>` — see the note on
 * {@link InvariantDefinition.check} for why the erasure is deliberate rather
 * than a shortcut.
 */
export type InvariantCheck<TContext = unknown> = (
	ctx: TContext,
) => InvariantOutcome | Promise<InvariantOutcome>

/**
 * Thrown by {@link InvariantRegistry.register} when `<moduleName>:<name>` is
 * already taken.
 *
 * `ManagedRegistry.register` — what this class is built on — warns and
 * OVERWRITES a duplicate id by default; that is right for a registry of
 * definitions a later one is meant to supersede, and wrong here. Two
 * invariants sharing a name is always a bug (two modules picked the same
 * words, or one module's own top-level registration ran twice), and
 * overwriting would silently keep whichever registration lost the race while
 * every reference to the other's `id` kept resolving as if it still existed.
 * Mirrors `ProbeNameCollisionError`.
 */
export class InvariantNameCollisionError extends Error {
	readonly moduleName: string
	readonly invariantName: string

	constructor(moduleName: string, invariantName: string) {
		super(
			`Invariant "${moduleName}:${invariantName}" is already registered. Two modules picked the same name, or this module registered itself twice — pick a different name, or find the second registration.`,
		)
		this.name = 'InvariantNameCollisionError'
		this.moduleName = moduleName
		this.invariantName = invariantName
	}
}

/**
 * Thrown by {@link InvariantRegistry.assert} when the named invariant's
 * check reports `violated`. Never thrown for `unknown` — a check that could
 * not answer is not a check that answered no, and `assert` treating the two
 * alike would turn "ask again with more context" into a hard failure the
 * check never claimed to be.
 */
export class ModuleInvariantError extends Error {
	readonly moduleName: string
	readonly invariantName: string
	readonly detail: string

	constructor(moduleName: string, invariantName: string, detail: string) {
		super(`${moduleName}: invariant "${invariantName}" violated — ${detail}`)
		this.name = 'ModuleInvariantError'
		this.moduleName = moduleName
		this.invariantName = invariantName
		this.detail = detail
	}
}

interface InvariantDefinition {
	readonly id: string
	readonly moduleName: string
	readonly name: string
	/**
	 * Erased to `never` at storage. Two invariants close over unrelated
	 * context shapes — a candidate message list here, a run directory and a
	 * presented fence there — and one map cannot state both statically. The
	 * pairing of a check with the shape of `ctx` it expects is a contract the
	 * CALLER of `evaluate`/`assert` keeps by knowing which id it is asking,
	 * the same way `ProbeRegistry` keeps event-kind/handler pairing outside
	 * the type system once an entry is stored by name. `never` rather than
	 * `unknown` in this field's own type because a function expecting
	 * `unknown` cannot accept one written for a narrower context —
	 * TypeScript checks parameters contravariantly — while `never` is a
	 * subtype of every context a real check is written for, so `register`'s
	 * generic check parameter is always assignable here.
	 */
	readonly check: InvariantCheck<never>
	violations: number
}

/**
 * The place a package registers a claim about its own live state, and the
 * place an operator or `namzu doctor` reads what this build asserts about
 * itself.
 *
 * Built on {@link ManagedRegistry} for storage and its logging, composed
 * rather than extended: `ManagedRegistry.register(id, item)` is public,
 * two-argument, and overwrites — exposing it directly (by extending the
 * class under the name `register`) would either fail to compile against
 * this class's three-argument `register(moduleName, name, check)`, or, named
 * differently, leave the inherited two-argument overwrite-on-collision
 * method reachable as an unguarded back door around the one guarantee this
 * class exists to make.
 */
export class InvariantRegistry {
	private readonly definitions: ManagedRegistry<InvariantDefinition>

	constructor() {
		this.definitions = new ManagedRegistry<InvariantDefinition>({
			componentName: 'InvariantRegistry',
		})
	}

	/**
	 * Reserve `<moduleName>:<name>` for `check`, once. Throws
	 * {@link InvariantNameCollisionError} on a second registration under the
	 * same id — see the class doc for why this does not delegate to the base
	 * registry's own collision handling.
	 */
	register<TContext>(moduleName: string, name: string, check: InvariantCheck<TContext>): void {
		const id = `${moduleName}:${name}`
		if (this.definitions.has(id)) {
			throw new InvariantNameCollisionError(moduleName, name)
		}
		this.definitions.register(id, {
			id,
			moduleName,
			name,
			check: check as InvariantCheck<never>,
			violations: 0,
		})
	}

	/** Every registered id, in registration order. */
	listIds(): string[] {
		return this.definitions.listIds()
	}

	/**
	 * Run `id`'s check against `ctx` and return what it said. A `violated`
	 * result counts against that invariant's own violation counter; `holds`
	 * and `unknown` do not, so the counter answers "how many times has this
	 * actually been false" and nothing else.
	 */
	async evaluate<TContext = never>(id: string, ctx: TContext): Promise<InvariantOutcome> {
		const definition = this.definitions.getOrThrow(id)
		const outcome = await definition.check(ctx as never)
		if (outcome.state === 'violated') definition.violations += 1
		return outcome
	}

	/**
	 * `evaluate`, but a `violated` outcome throws {@link ModuleInvariantError}
	 * instead of being handed back. `unknown` does not throw — see the error
	 * class's own doc.
	 */
	async assert<TContext = never>(id: string, ctx: TContext): Promise<void> {
		const outcome = await this.evaluate(id, ctx)
		if (outcome.state === 'violated') {
			const definition = this.definitions.getOrThrow(id)
			throw new ModuleInvariantError(definition.moduleName, definition.name, outcome.detail)
		}
	}

	/** Violations `id` has recorded since this registry was created. */
	violationCount(id: string): number {
		return this.definitions.getOrThrow(id).violations
	}
}

/**
 * The process-wide registry. `compaction.ts` and `claim-disk.ts` each
 * register one invariant against it at import time — see the registration
 * beside each — which is what makes `listIds()` non-empty from the day this
 * file lands rather than a registry nothing has ever driven.
 */
export const invariants: InvariantRegistry = new InvariantRegistry()

/** A scoped registry for a test, or a host that wants its own. */
export function createInvariantRegistry(): InvariantRegistry {
	return new InvariantRegistry()
}
