import { VERSION } from '../version.js'

/**
 * Who is calling, said once.
 *
 * No driver identified this kernel to a provider. The only user-agent
 * anywhere was on one OAuth code path, set so a token-exchange endpoint
 * would accept the request — that is load-bearing impersonation, not
 * attribution, and it must not be touched.
 *
 * What attribution buys is not vanity. A provider reading its own logs can
 * tell a kernel's traffic from a browser's; a rate-limit or an abuse
 * investigation lands on the right party; and a driver bug reported by a
 * vendor arrives with something to search for. None of that is possible
 * from an unlabelled request.
 *
 * ## One header, and only one
 *
 * Every additional header is a thing a proxy may strip, a vendor may
 * reject, and a reader has to reconcile. The helper returns exactly one
 * key and a test asserts the count — a driver wanting to send something of
 * its own sends it at its own seam rather than growing this.
 */

export interface AppIdentity {
	/** Product name, as it should appear in a vendor's logs. */
	readonly product: string
	/** Version of the product. Read, never hand-copied. */
	readonly version: string
	/** Where a vendor can find out what this is. */
	readonly url: string
}

/**
 * `version` comes from `VERSION`, which is read from the package manifest
 * — a hand-copied literal here would be wrong from the first release after
 * somebody forgot it, and wrong in the one place a vendor is reading to
 * decide which build has the bug.
 */
export const NAMZU_APP_IDENTITY: AppIdentity = {
	product: 'namzu',
	version: VERSION,
	url: 'https://github.com/cogitave/namzu',
}

/**
 * The single header a driver merges at its own seam.
 *
 * Pure, and takes the identity as an argument, so a host embedding this
 * kernel in its own product can say so — and so a driver cannot hardcode
 * the constant and quietly ignore what the host asked for.
 */
export function attributionHeaders(
	identity: AppIdentity = NAMZU_APP_IDENTITY,
): Record<string, string> {
	return { 'User-Agent': `${identity.product}/${identity.version} (+${identity.url})` }
}
