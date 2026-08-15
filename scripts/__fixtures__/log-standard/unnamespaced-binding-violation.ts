// Deliberately-violating fixture for the component: binding ratchet
// (checkUnnamespacedBindingRatchet). Same fabricated-`rel` technique as
// get-root-logger-violation.ts, for the same reason: the rule only counts
// inside packages/sdk/src/, and this file does not live there.
export function attachLogger(log: { child(ctx: Record<string, unknown>): unknown }) {
	return log.child({ component: 'FixtureWidget' })
}
