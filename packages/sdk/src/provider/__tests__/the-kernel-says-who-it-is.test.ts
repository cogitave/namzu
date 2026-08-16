import { describe, expect, it } from 'vitest'

import { VERSION } from '../../version.js'
import { NAMZU_APP_IDENTITY, attributionHeaders } from '../attribution.js'

/**
 * No driver identified this kernel to a provider.
 *
 * The only user-agent anywhere was on one OAuth code path, set so a
 * token-exchange endpoint would accept the request — load-bearing
 * impersonation, not attribution, and untouched by this.
 *
 * What attribution buys is not vanity. A vendor reading its own logs can
 * tell a kernel's traffic from a browser's; a rate-limit or abuse
 * investigation lands on the right party; a driver bug a vendor reports
 * arrives with something to search for. An unlabelled request offers none
 * of that.
 */

describe('the attribution header', () => {
	it('is exactly one key', () => {
		// Every additional header is something a proxy may strip, a vendor
		// may reject, and a reader has to reconcile. A driver wanting to send
		// its own sends it at its own seam rather than growing this — and
		// this assertion is what stops the shared helper accumulating them.
		expect(Object.keys(attributionHeaders())).toHaveLength(1)
	})

	it("carries the SDK's real version, not a copy of it", () => {
		// Compared against the imported const. A hand-written literal in
		// `attribution.ts` is wrong from the first release after somebody
		// forgets it — and wrong in the one place a vendor reads to decide
		// which build has the bug they are reporting.
		expect(attributionHeaders()['User-Agent']).toContain(VERSION)
		expect(NAMZU_APP_IDENTITY.version).toBe(VERSION)
	})

	it('sends what a host asked for, not the constant', () => {
		// A host embedding this kernel in its own product says so. If a
		// driver hardcoded `NAMZU_APP_IDENTITY` at its seam this would still
		// pass here and fail at the wire, which is why the driver tests below
		// assert the same property through a real client.
		const header = attributionHeaders({
			product: 'someone-elses-app',
			version: '9.9.9',
			url: 'https://example.invalid',
		})['User-Agent']

		expect(header).toBe('someone-elses-app/9.9.9 (+https://example.invalid)')
		expect(header).not.toContain('namzu')
	})

	it('is a shape a vendor can parse', () => {
		// `product/version (+url)` is the conventional user-agent comment
		// form. A free-form string is a string a vendor's log pipeline cannot
		// split, which costs exactly the ability this exists to provide.
		expect(attributionHeaders()['User-Agent']).toMatch(/^namzu\/\S+ \(\+https:\/\/\S+\)$/)
	})
})
