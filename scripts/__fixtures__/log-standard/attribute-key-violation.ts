// Deliberately-violating (and deliberately passing) fixture for rule 4
// (checkNamespacedAttributeKeys). Imports the real Logger and LogAttributes
// types rather than a hand-rolled stand-in.
import type { Logger } from '../../../packages/sdk/src/utils/logger.js'
import type { LogAttributes } from '../../../packages/sdk/src/utils/log/attributes.js'

const EVENT_NAME_ATTRIBUTE = 'namzu.event.name'
const UNRESOLVABLE_AT_RUNTIME = Math.random() > 0.5 ? 'namzu.a' : 'namzu.b'

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
}
