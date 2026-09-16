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
 * re-resolves rather than remembering an address. It is handed the name being
 * looked up, which is how {@link recordLoopbackDns} observes them.
 */
export function stubLoopbackDns(
	address: (hostname: string) => string = () => '127.0.0.1',
): () => void {
	const original = dns.lookup
	const lookup = ((hostname: string, options: unknown, callback?: unknown) => {
		const done = (typeof options === 'function' ? options : callback) as (
			err: NodeJS.ErrnoException | null,
			resolved: unknown,
			family?: number,
		) => void
		if (options && typeof options === 'object' && (options as { all?: boolean }).all) {
			done(null, [{ address: address(hostname), family: 4 }])
			return
		}
		done(null, address(hostname), 4)
	}) as unknown as typeof dns.lookup
	dns.lookup = lookup
	return () => {
		dns.lookup = original
	}
}

/**
 * Resolve nothing: every lookup fails the way a host with no cluster resolver
 * fails a `*.svc.cluster.local` name.
 *
 * The counterpart of {@link stubLoopbackDns}, and the only way to reproduce
 * the failure this whole address mode exists for — a real `ENOTFOUND` needs a
 * name the machine running the suite genuinely cannot resolve, which is not a
 * property a test may assume of somebody else's resolver (a search domain or
 * a wildcard would answer it).
 *
 * `hostnames` records what was asked for, so a case can also assert that a
 * literal pod IP reached the resolver at NO point: `net.connect` skips the
 * lookup entirely for an IP, which is most of what `'pod-ip'` buys.
 */
export function stubFailingDns(code = 'ENOTFOUND'): {
	readonly hostnames: readonly string[]
	restore(): void
} {
	const original = dns.lookup
	const hostnames: string[] = []
	const lookup = ((hostname: string, options: unknown, callback?: unknown) => {
		hostnames.push(hostname)
		const done = (typeof options === 'function' ? options : callback) as (
			err: NodeJS.ErrnoException | null,
		) => void
		// Shaped like the resolver's own refusal, `code` included: the
		// transport reads that code to tell a name that does not resolve from
		// a host that refused a connection.
		const error = Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), {
			code,
			syscall: 'getaddrinfo',
			hostname,
		})
		done(error)
	}) as unknown as typeof dns.lookup
	dns.lookup = lookup
	return {
		hostnames,
		restore: () => {
			dns.lookup = original
		},
	}
}

/**
 * {@link stubLoopbackDns}, plus the list of names that went through it.
 *
 * A `'service'` handle resolves its FQDN on every dial and a `'pod-ip'`
 * handle resolves nothing at all, so this list is the direct evidence of
 * which address a call actually used — rather than an inference from which
 * socket happened to answer.
 */
export function recordLoopbackDns(address: () => string = () => '127.0.0.1'): {
	readonly hostnames: readonly string[]
	restore(): void
} {
	const hostnames: string[] = []
	const restore = stubLoopbackDns((hostname) => {
		hostnames.push(hostname)
		return address()
	})
	return { hostnames, restore }
}
