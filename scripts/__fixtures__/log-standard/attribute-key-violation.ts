// Deliberately-violating (and deliberately passing) fixture for rule 4
// (checkNamespacedAttributeKeys). Imports the real Logger and LogAttributes
// types rather than a hand-rolled stand-in.
import type { Logger } from '../../../packages/sdk/src/utils/logger.js'
import type { LogAttributes } from '../../../packages/sdk/src/utils/log/attributes.js'

const EVENT_NAME_ATTRIBUTE = 'namzu.event.name'
const UNRESOLVABLE_AT_RUNTIME = Math.random() > 0.5 ? 'namzu.a' : 'namzu.b'

// The shape of the real constants table: `as const`, so every property has
// a string LITERAL type and a computed key reading one folds.
const ATTRS = { RUN_ID: 'namzu.run.id' } as const
// The same table without `as const`. Its properties are `string`, which is
// not a provable key — a mutable property could be anything at the moment
// the log call runs, so this must NOT fold.
const WIDENED = { RUN_ID: 'namzu.run.id' }

const compliantAttributes: LogAttributes = { 'namzu.request.id': 'r1' }
function buildExceptionAttributes(): LogAttributes {
	return { 'exception.message': 'boom' }
}

export function demo(log: Logger, id: string) {
	// Literal, un-namespaced key — violates.
	log.info('a', { requestId: id })
	// Shorthand, un-namespaced — violates.
	log.info('b', { id })
	// Computed key that folds to a literal `const` string — resolves to
	// "namzu.event.name", which matches the pattern. Passes despite being
	// computed; this is the case a literal-key-only walk would either flag
	// wrongly or skip and never check at all.
	log.info('c', { [EVENT_NAME_ATTRIBUTE]: 'boot' })
	// Computed key that CANNOT be folded to a literal — a ternary, not a
	// `const string` reference. Deny-by-default: this must violate, because
	// the gate cannot prove it is namespaced, not because it necessarily
	// isn't at runtime.
	log.info('d', { [UNRESOLVABLE_AT_RUNTIME]: true })
	// A namespaced literal key passes.
	log.info('e', { 'namzu.request.id': id })
	// An identifier typed LogAttributes, passed whole — passes without a
	// property walk, because its declared TYPE already proves every key is
	// namespaced.
	log.info('f', compliantAttributes)
	// A function call returning LogAttributes — same reasoning, one hop
	// through a call instead of a variable.
	log.info('g', buildExceptionAttributes())
	// An un-namespaced identifier passed whole — violates: its type is not
	// assignable to LogAttributes.
	const badBag = { errorCode: 'E1' }
	log.info('h', badBag)
	// A spread of a LogAttributes-typed value inside an otherwise-compliant
	// literal — passes.
	log.info('i', { ...compliantAttributes, 'namzu.extra': 1 })
	// A spread of a plain, un-namespaced object — violates.
	const untypedExtra = { rawField: 1 }
	log.info('j', { 'namzu.ok': true, ...untypedExtra })
	// A computed key reading an `as const` table — folds to
	// "namzu.run.id" and passes. This is the shape every real call site
	// that uses the shared constants table has, and the branch that
	// resolves it was missing: the gate used to reward the hand-typed
	// string over the constant, which is exactly backwards.
	log.info('k', { [ATTRS.RUN_ID]: id })
	// The same access against a table that is NOT `as const`. Its type is
	// `string`, so it does not fold and must violate — the fold goes
	// through the TYPE precisely so that a mutable property is refused.
	log.info('l', { [WIDENED.RUN_ID]: id })
}
