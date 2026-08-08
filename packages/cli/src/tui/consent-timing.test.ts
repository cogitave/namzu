import { describe, expect, it } from 'vitest'

import { APPROVAL_SETTLE_MS, approvalIsDeliberate } from './consent-timing.js'

/**
 * The predicate only. That each consent screen actually consults it — the part
 * that matters and the part a helper test cannot establish — is pinned against
 * a rendered `<App>`: the tool prompt in `__tests__/app-permission-keys.test.tsx`,
 * the trust gate in `__tests__/app-trust-gate.test.tsx`.
 */
describe('approvalIsDeliberate', () => {
	it('refuses a keypress that arrives with the prompt', () => {
		const opened = 1_000
		expect(approvalIsDeliberate(opened, opened)).toBe(false)
	})

	it('refuses a keypress still inside the settling window', () => {
		const opened = 1_000
		expect(approvalIsDeliberate(opened, opened + APPROVAL_SETTLE_MS - 1)).toBe(false)
	})

	it('accepts one on the boundary and after it', () => {
		const opened = 1_000
		expect(approvalIsDeliberate(opened, opened + APPROVAL_SETTLE_MS)).toBe(true)
		expect(approvalIsDeliberate(opened, opened + 10_000)).toBe(true)
	})

	it('refuses when no prompt is recorded as open', () => {
		// The fail-safe direction. `null` means the caller cannot establish that
		// anything was shown, and "I cannot establish this" is not consent.
		expect(approvalIsDeliberate(null, 10_000)).toBe(false)
	})
})
