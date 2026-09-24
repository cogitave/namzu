/**
 * One spelling per address, decided before anyone judges the address.
 *
 * The browser tools' `url` and `origin` arguments are canonicalised by their
 * input schema, and the registry hands the gate and the reviewer the schema's
 * OUTPUT (`ToolManager.prepareExecution`, `toolsets/manager.ts`). So a site rule written as
 * `^https://github\.com(?:[/?#]|$)` is tested against the one spelling the
 * browser will load, never against `HTTPS://GitHub.com:443/`,
 * `https://github.com./` or `https://%67ithub.com/`, which name the same page
 * and would each slip past a deny written for the plain form.
 *
 * The canonical form is the WHATWG URL serialisation (`new URL(x).href`),
 * which already lowercases the scheme and host, converts an internationalised
 * host to punycode, drops a default port, decodes percent-encoded host bytes
 * and reads every IPv4 spelling (`2852039166`, `0xA9FEA9FE`,
 * `0251.0376.0251.0376`, `169.254.43518`) as dotted-quad. On top of that:
 *
 * - trailing dots on the host are removed (`github.com.` is `github.com` to
 *   DNS and to a person, and a different string to a pattern);
 * - only `http:` and `https:` are accepted, plus the literal `about:blank`;
 * - an address carrying a user name or password is refused — it is how
 *   `https://github.com@evil.example/` reads as GitHub to a person;
 * - cloud metadata endpoints are refused outright, in every spelling the
 *   parser folds into them. This is a floor, not the site policy: a private
 *   or loopback address is left to the operator's site rules, and a DNS name
 *   that RESOLVES to a metadata address is the host's to catch after the
 *   navigation lands.
 */

export type BrowserUrlVerdict =
	| { readonly ok: true; readonly url: string; readonly origin: string }
	| { readonly ok: false; readonly reason: string }

export type BrowserOriginVerdict =
	| { readonly ok: true; readonly origin: string }
	| { readonly ok: false; readonly reason: string }

/** Longest address the tools accept. Longer is not a page anyone meant to name. */
export const BROWSER_URL_MAX_LENGTH = 8192

const ABOUT_BLANK = 'about:blank'

/** Host names of cloud metadata services. Compared after lowercasing and trailing-dot removal. */
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata', 'metadata.goog'])

/**
 * IPv4 metadata endpoints: AWS, GCP, Azure, Oracle and DigitalOcean
 * (169.254.169.254), and Alibaba Cloud (100.100.100.200).
 */
const METADATA_IPV4 = new Set(['169.254.169.254', '100.100.100.200'])

/** IPv6 metadata endpoints, in the parser's compressed form. AWS Nitro. */
const METADATA_IPV6 = new Set(['fd00:ec2::254'])

function stripTrailingDots(hostname: string): string {
	return hostname.replace(/\.+$/, '')
}

/** Eight hextets of a compressed IPv6 literal, or undefined if it is not one. */
function expandIpv6(address: string): number[] | undefined {
	const halves = address.split('::')
	if (halves.length > 2) return undefined
	const parse = (part: string | undefined): number[] | undefined => {
		if (part === undefined || part === '') return []
		const out: number[] = []
		for (const piece of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
			out.push(Number.parseInt(piece, 16))
		}
		return out
	}
	const head = parse(halves[0])
	const tail = parse(halves[1])
	if (!head || !tail) return undefined
	if (halves.length === 1) return head.length === 8 ? head : undefined
	const fill = 8 - head.length - tail.length
	if (fill < 1) return undefined
	return [...head, ...new Array<number>(fill).fill(0), ...tail]
}

function ipv4Of(high: number, low: number): string {
	return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`
}

/**
 * IPv4 addresses an IPv6 literal carries in a well-known embedding: mapped
 * (`::ffff:a.b.c.d`), compatible (`::a.b.c.d`), SIIT (`::ffff:0:a.b.c.d`),
 * NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`) and 6to4 (`2002:AABB:CCDD::`).
 * Each is a way to reach the IPv4 address from an IPv6 spelling.
 */
function embeddedIpv4(h: readonly number[]): string[] {
	const out: string[] = []
	const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0)
	const last = ipv4Of(h[6] ?? 0, h[7] ?? 0)
	if (zero(0, 5) && (h[5] === 0xffff || h[5] === 0)) out.push(last)
	if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) out.push(last)
	if (h[0] === 0x64 && h[1] === 0xff9b) out.push(last)
	if (h[0] === 0x2002) out.push(ipv4Of(h[1] ?? 0, h[2] ?? 0))
	return out
}

/**
 * Is this host a cloud metadata endpoint, in any spelling the URL parser
 * folds into one? `hostname` is a URL's `hostname` (IPv6 in brackets) or a
 * bare name or address.
 */
export function isCloudMetadataHost(hostname: string): boolean {
	let host = stripTrailingDots(hostname.trim().toLowerCase())
	if (host === '') return false
	// Let the WHATWG parser fold every IPv4 and IPv6 spelling into one.
	const bracketed = host.startsWith('[') ? host : host.includes(':') ? `[${host}]` : host
	try {
		host = stripTrailingDots(new URL(`http://${bracketed}/`).hostname)
	} catch {
		return false
	}
	if (METADATA_HOSTNAMES.has(host) || METADATA_IPV4.has(host)) return true
	if (!host.startsWith('[')) return false
	const v6 = host.slice(1, -1)
	if (METADATA_IPV6.has(v6)) return true
	const hextets = expandIpv6(v6)
	if (!hextets) return false
	return embeddedIpv4(hextets).some((v4) => METADATA_IPV4.has(v4))
}

/**
 * The one spelling of an address the browser may be sent to, or why not.
 *
 * Accepts absolute `http:` and `https:` URLs and `about:blank`. See the
 * module comment for what is folded and what is refused.
 */
export function canonicalizeBrowserUrl(raw: string): BrowserUrlVerdict {
	if (typeof raw !== 'string' || raw.trim() === '')
		return { ok: false, reason: 'the address is empty' }
	if (raw.length > BROWSER_URL_MAX_LENGTH)
		return { ok: false, reason: `the address is longer than ${BROWSER_URL_MAX_LENGTH} characters` }
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		return {
			ok: false,
			reason: 'the address is not an absolute URL; give the full https:// address',
		}
	}
	if (url.protocol === 'about:') {
		if (url.pathname.toLowerCase() === 'blank' && url.search === '' && url.hash === '')
			return { ok: true, url: ABOUT_BLANK, origin: 'null' }
		return { ok: false, reason: 'only about:blank is allowed among about: addresses' }
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return {
			ok: false,
			reason: `the scheme "${url.protocol}" is not allowed; only http and https addresses (and about:blank) can be opened`,
		}
	}
	if (url.username !== '' || url.password !== '') {
		return {
			ok: false,
			reason:
				'the address carries a user name or password (user@host); credentials never go in an address — open the site and let the user sign in',
		}
	}
	const host = stripTrailingDots(url.hostname)
	if (host === '') return { ok: false, reason: 'the address has no host' }
	if (host !== url.hostname) {
		url.hostname = host
		// The setter re-parses; a host that did not survive is not one to open.
		if (stripTrailingDots(url.hostname) !== host)
			return { ok: false, reason: 'the address host could not be canonicalised' }
	}
	if (isCloudMetadataHost(url.hostname)) {
		return {
			ok: false,
			reason: `${url.hostname} is a cloud metadata endpoint, which the browser never opens`,
		}
	}
	return { ok: true, url: url.href, origin: url.origin }
}

/**
 * The canonical origin (`scheme://host[:port]`) a `browser_act` call names,
 * or why it is not one. A trailing `/` is accepted; a path, query or fragment
 * is not — the argument is an origin, copied from the snapshot header.
 */
export function canonicalizeBrowserOrigin(raw: string): BrowserOriginVerdict {
	const verdict = canonicalizeBrowserUrl(raw)
	if (!verdict.ok) return verdict
	if (verdict.url === ABOUT_BLANK)
		return { ok: false, reason: 'about:blank has no origin to act on; open a page first' }
	const url = new URL(verdict.url)
	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		return {
			ok: false,
			reason: `"${raw}" is a URL, not an origin; copy the origin from the snapshot header (${url.origin})`,
		}
	}
	return { ok: true, origin: verdict.origin }
}

export type BrowserSitePatternVerdict =
	| { readonly ok: true; readonly pattern: string }
	| { readonly ok: false; readonly reason: string }

/**
 * The canonical spelling of a site key an operator or a job grants —
 * `https://github.com`, `https://*.example.com`, `http://localhost:*` — or
 * why it is not one.
 *
 * The scheme is literal (`http` or `https`). The host may begin with `*.`,
 * meaning one or more labels in front of the rest. The port may be `*`, any
 * port; a default port is dropped. The host is lowercased and punycoded like
 * a URL's. A bare `*`, a path, credentials and metadata hosts are refused.
 */
export function canonicalizeBrowserSitePattern(raw: string): BrowserSitePatternVerdict {
	const trimmed = typeof raw === 'string' ? raw.trim() : ''
	const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(\*\.)?([^/:?#@]+)(?::(\d{1,5}|\*))?\/?$/.exec(
		trimmed,
	)
	if (!match) {
		return {
			ok: false,
			reason: `"${raw}" is not a site; write scheme://host, optionally *.host and :port or :*, with no path`,
		}
	}
	if ((match[3] ?? '').includes('*')) {
		return {
			ok: false,
			reason: `"${raw}" has a wildcard inside the host; a wildcard may only be a leading *. before a domain`,
		}
	}
	const scheme = (match[1] ?? '').toLowerCase()
	const wildcard = match[2] !== undefined
	const port = match[4]
	if (scheme !== 'http' && scheme !== 'https')
		return { ok: false, reason: `the scheme "${scheme}:" is not allowed; only http and https` }
	const probe = canonicalizeBrowserOrigin(
		`${scheme}://${match[3]}${port !== undefined && port !== '*' ? `:${port}` : ''}`,
	)
	if (!probe.ok) return { ok: false, reason: probe.reason }
	const probeUrl = new URL(probe.origin)
	if (
		wildcard &&
		(probeUrl.hostname.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(probeUrl.hostname))
	) {
		return { ok: false, reason: 'a wildcard cannot precede an IP address' }
	}
	const host = `${wildcard ? '*.' : ''}${probeUrl.hostname}`
	const portPart = port === '*' ? ':*' : probeUrl.port !== '' ? `:${probeUrl.port}` : ''
	return { ok: true, pattern: `${scheme}://${host}${portPart}` }
}
