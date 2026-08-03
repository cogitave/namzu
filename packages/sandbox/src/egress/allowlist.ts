/**
 * Host matching for an egress allowlist.
 *
 * Kept apart from the proxy because this is the part that decides whether
 * untrusted code reaches the network, and it has to be readable on its own
 * and testable without opening a socket.
 */

/**
 * Whether `host` is covered by `allowed`.
 *
 * Two forms, and only two:
 *
 *  - `api.example.com` — that exact host.
 *  - `.example.com` — that domain and any subdomain of it.
 *
 * Substring matching is deliberately NOT one of them. `host.includes(entry)`
 * is the obvious implementation and it is a hole: an allowlist entry of
 * `example.com` would admit `example.com.attacker.net`, which is a domain
 * the attacker owns. Suffix matching has the same hole without the leading
 * dot — `notexample.com` ends with `example.com` — which is why the
 * wildcard form requires it.
 *
 * Comparison is case-insensitive and ignores a trailing dot, because DNS
 * treats `Example.COM.` and `example.com` as the same name and an allowlist
 * that does not would be bypassable by typing the host differently.
 */
export function isHostAllowed(host: string, allowed: readonly string[]): boolean {
	const target = normalizeHost(host)
	if (target.length === 0) return false

	for (const raw of allowed) {
		const entry = normalizeHost(raw)
		if (entry.length === 0) continue

		if (entry.startsWith('.')) {
			// `.example.com` covers `example.com` itself and any subdomain.
			// Covering the apex matters: an allowlist author writing the
			// wildcard form means the site, and a policy that admits
			// `www.example.com` but not `example.com` reads as a bug.
			const domain = entry.slice(1)
			if (target === domain || target.endsWith(entry)) return true
			continue
		}

		if (target === entry) return true
	}

	return false
}

/** Lowercase, trailing-dot-free, whitespace-free. */
function normalizeHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, '')
}

/**
 * Split an authority into host and port.
 *
 * A CONNECT target and a `Host` header both carry `host:port`, and the
 * allowlist is about the HOST — matching the whole authority would make an
 * entry admit one port and silently refuse the same site on another.
 * IPv6 literals are bracketed, which is why this is not a `split(':')`.
 */
export function splitAuthority(authority: string): { host: string; port?: number } {
	const value = authority.trim()

	if (value.startsWith('[')) {
		const close = value.indexOf(']')
		if (close < 0) return { host: value }
		const host = value.slice(1, close)
		const rest = value.slice(close + 1)
		const port = rest.startsWith(':') ? Number(rest.slice(1)) : undefined
		return port !== undefined && Number.isInteger(port) ? { host, port } : { host }
	}

	const colon = value.lastIndexOf(':')
	if (colon < 0) return { host: value }
	const port = Number(value.slice(colon + 1))
	if (!Number.isInteger(port)) return { host: value }
	return { host: value.slice(0, colon), port }
}
