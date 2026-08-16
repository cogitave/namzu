/**
 * Nominal-brand machinery for the id types — declared here, not yet applied.
 *
 * Today every id in `./index.ts` is a bare template-literal type, and
 * TypeScript's assignability rule for those means
 * `const x: RunId = 'run_totally-made-up'` compiles with no cast and no
 * factory call. The result is indistinguishable at the type level from an id
 * `generateRunId()` actually minted, so the compiler cannot tell a real id
 * from a plausible-looking string.
 *
 * Applying this brand is a separate change, on purpose: flipping the
 * declarations turns every existing bare literal into an error at once, and
 * that is a `major` with a migration in front of it. This file ships the
 * machinery and the runtime constructors that use it so the two can land
 * independently — the constructors are useful on their own, since there is
 * no runtime prefix validation in the tree at all today.
 *
 * **The prefix stays in the type, and that is the one place this diverges
 * from a plain `Branded<B>`.** A brand alone would render as `RunId` in
 * hovers and errors and tell a reader nothing about the shape. Keeping
 * `` `${Prefix}_${string}` `` in the intersection means an editor hover still
 * shows `run_${string}`, which is most of what makes these ids readable in
 * a log line.
 */

declare const ID_BRAND: unique symbol

/**
 * An id with both its wire shape and a nominal tag.
 *
 * `B` is a string tag rather than the type's own name by convention — two
 * ids with the same prefix but different meanings must not be mutually
 * assignable, and only the tag can separate them.
 */
export type Id<Prefix extends string, B extends string> = `${Prefix}_${string}` & {
	readonly [ID_BRAND]: B
}
