// Deliberately-violating fixture for the receiver-type resolution rules 3
// and 4 (checkConstantBody, checkNamespacedAttributeKeys). Imports the REAL
// Logger interface — never a hand-rolled stand-in — so the fixture is
// checked against the same type production code is, per
// fixture-must-match-production.
import type { Logger } from '../../../packages/sdk/src/utils/logger.js'

// Aliased receiver: `l` is not spelled `log`/`logger`, so a name-matching
// walk would miss this. The type-checker sees straight through the alias.
export function aliasedViolation(logger: Logger) {
	const l = logger
	l.info(`aliased and non-constant: ${logger}`)
}

// Destructured receiver: no property access at the call site at all — the
// call is a bare `warn(...)`. A receiver-type check has to walk back to
// where `warn` came from.
export function destructuredViolation(logger: Logger) {
	const { warn } = logger
	warn('destructured' + ' concatenated')
}

// A structurally different object with the same three method NAMES this
// gate cares about — but no `debug()` and no `child()`, so it is NOT
// assignable to Logger. Its own non-constant body must NOT be flagged: a
// name-matching walk would report this; a type-aware one does not.
export interface NotALogger {
	info(message: string, data?: Record<string, unknown>): void
	warn(message: string, data?: Record<string, unknown>): void
	error(message: string, data?: Record<string, unknown>): void
}
export function notALoggerCall(x: NotALogger, part: string) {
	x.info('this looks like a violation but the receiver is not a Logger: ' + part)
	// Same reasoning for rule 4: `rawKey` is not a namespaced attribute key,
	// but this call must not contribute to checkNamespacedAttributeKeys
	// either, because `x` is still not a Logger.
	x.warn('also not a Logger', { rawKey: part })
}
