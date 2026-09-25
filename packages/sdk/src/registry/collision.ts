/**
 * What a registry does when a second item claims an id it already holds.
 *
 * Nine `*CollisionError` classes existed across the SDK before this file did
 * (tool, host command, config namespace, prompt contribution, read model,
 * invariant, probe, provider — see `RegistryCollisionError` below), each
 * hand-rolled, and a handful of registries never threw at all —
 * `ManagedRegistry.register` warned and overwrote by default, `AdvisorRegistry`
 * and the two connector managers (`manager/connector/environment.ts`,
 * `tenant.ts`) warned and kept the original, and `SkillRegistry.add` did
 * neither, in total silence. This file gives the concept a shared
 * vocabulary, and every one of those registries now throws on a duplicate id
 * by default (`RegistryCollisionError` or a domain-specific subclass); a
 * caller that genuinely means to replace an existing entry says so
 * explicitly at the call site.
 */

/**
 * A named collision policy for a `ManagedRegistry`.
 *
 * - `'throw'` (default): raise a {@link RegistryCollisionError} naming this
 *   registry and the id, and leave the existing item in place. Right for
 *   every registry here unless a caller can name a reason a second
 *   registration under one id should not be a bug.
 * - `'warn-overwrite'`: log a warning and replace the existing item.
 *   `ToolRegistry` used to keep this policy for its own `register`, so a
 *   host mounting the same tool twice (once a legitimate, common shape)
 *   kept working unchanged; that class is gone now (plan.md v3 §2) — a
 *   `ToolManager`'s toolsets throw `ToolsetConflictError` on any collision
 *   instead, naming both sources, with no overwrite mode at all.
 * - `'warn-skip'`: log a warning and keep the existing item — the one being
 *   registered is discarded.
 *
 * A single call that needs to replace an existing entry on a registry whose
 * policy is `'throw'` passes `{ replace: true }` to that call instead of
 * changing the registry's policy — see `ManagedRegistry.register`.
 */
export type RegistryCollisionPolicy = 'throw' | 'warn-overwrite' | 'warn-skip'

/**
 * A second item claiming an id a registry already holds.
 *
 * The base class every SDK `*CollisionError` extends, so a host that wants
 * to catch "some registry collided" without naming every concrete error
 * class can catch this one instead. Each concrete subclass keeps its own
 * `name`, message and fields exactly as before — this only adds
 * `registryName` and `collidingId`, which every collision shares by
 * definition — and `ManagedRegistry`'s own `'throw'` policy (see
 * {@link RegistryCollisionPolicy}) raises this class directly when a
 * registry has no domain-specific subclass of its own.
 */
export class RegistryCollisionError extends Error {
	/** Which registry raised this, e.g. `"ToolRegistry"`. */
	readonly registryName: string
	/** The id or name two registrations collided on. */
	readonly collidingId: string

	constructor(registryName: string, collidingId: string, message?: string) {
		super(message ?? `"${collidingId}" is already registered in ${registryName}.`)
		this.name = 'RegistryCollisionError'
		this.registryName = registryName
		this.collidingId = collidingId
	}
}
