/**
 * Resolve every hostname to loopback for the duration of a test.
 *
 * The control-plane suites describe sandboxes the way a cluster does, with
 * `status.serviceFQDN` values like `sbx.namzu-sandboxes.svc.cluster.local`.
 * Now that `create()` reaches the guest agent before it resolves — the
 * acquire-time privilege probe — those names have to lead somewhere. Making
 * them lead to a loopback stand-in keeps the fixtures describing real cluster
 * shapes instead of rewriting every FQDN to `127.0.0.1`, which would quietly
 * delete the "the transport dials a NAME, not an address" property those
 * fixtures exist to hold.
 *
 * `dns.lookup` is what `net.connect` calls; the API-server client is pointed
 * at a literal `127.0.0.1` URL and never goes through it.
 */

import dns from 'node:dns'

/**
 * `address` is read on every lookup rather than captured once, so a case can
 * change what a name resolves to mid-test — which is exactly what a resumed
 * pod does to its Service FQDN, and the only way to prove the transport
 * re-resolves rather than remembering an address.
 */
export function stubLoopbackDns(address: () => string = () => '127.0.0.1'): () => void {
	const original = dns.lookup
	const lookup = ((_hostname: string, options: unknown, callback?: unknown) => {
		const done = (typeof options === 'function' ? options : callback) as (
			err: NodeJS.ErrnoException | null,
			resolved: unknown,
			family?: number,
		) => void
		if (options && typeof options === 'object' && (options as { all?: boolean }).all) {
			done(null, [{ address: address(), family: 4 }])
			return
		}
		done(null, address(), 4)
	}) as unknown as typeof dns.lookup
	dns.lookup = lookup
	return () => {
		dns.lookup = original
	}
}
