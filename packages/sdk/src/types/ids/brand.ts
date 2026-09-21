/** Nominal identity is independent of the identifier's serialized spelling. */
declare const ID_BRAND: unique symbol

/**
 * The nominal tag of an entity id. An interface rather than an inline object
 * type so a declaration file can name it: a zod schema over branded ids makes
 * TypeScript expand the id type, and an anonymous `{ [ID_BRAND]: B }` would
 * then need the module-private symbol spelled in the emitting file.
 */
export interface IdBrand<B extends string> {
	readonly [ID_BRAND]: B
}

/** An opaque string whose tag prevents mixing different entity types. */
export type Id<B extends string> = string & IdBrand<B>

/**
 * Internal escape hatch for factories and checked constructors. Not exported
 * from the package barrel; consumers validate external strings with `as*Id`.
 */
export function unsafeId<T extends string>(value: string): T {
	return value as unknown as T
}
