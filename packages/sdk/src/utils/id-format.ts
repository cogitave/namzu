const HEX = '[0-9a-fA-F]'
const UUID = `${HEX}{8}-${HEX}{4}-[1-8]${HEX}{3}-[89abAB]${HEX}{3}-${HEX}{12}`

/** Internal shared spelling rule for runtime checks and JSON-schema-compatible schemas. */
export function entityIdPattern(legacyPrefix: string): RegExp {
	const escapedPrefix = legacyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	// JavaScript's $ also matches before a final newline. The final lookahead
	// requires the actual end so no accepted id can carry a control character.
	return new RegExp(`^(?:${UUID}|${escapedPrefix}[A-Za-z0-9_-]+)$(?![\\s\\S])`)
}
