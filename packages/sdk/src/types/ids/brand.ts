/** Nominal identity is independent of the identifier's serialized spelling. */
declare const ID_BRAND: unique symbol

/** An opaque string whose tag prevents mixing different entity types. */
export type Id<B extends string> = string & {
	readonly [ID_BRAND]: B
}

/**
 * Internal escape hatch for factories and checked constructors. Not exported
 * from the package barrel; consumers validate external strings with `as*Id`.
 */
export function unsafeId<T extends string>(value: string): T {
	return value as unknown as T
}
