import { lookup as dnsLookup } from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'

/**
 * Address-level screening for egress.
 *
 * The allowlist answers "is this NAME permitted". That is a different
 * question from "where does this name go", and only the second one decides
 * what the socket actually reaches. A name on the allowlist whose DNS the
 * attacker controls — or that simply has an inward-pointing record — resolves
 * to the loopback interface, the private network the sandbox host sits on, or
 * the link-local address cloud metadata services answer on.
 *
 * The proxy stamps a brokered credential on before the request goes out, so
 * without this screen the credential-brokering design is the delivery
 * mechanism: the token reaches whatever the name resolved to. That is the
 * exact outcome `BrokeredCredential.host` exists to prevent, and it could not
 * prevent it while the scope was a name rather than an address.
 */

/** Blocked ranges, and the name of what each one protects. */
interface Range {
	readonly reason: string
	readonly matches: (octets: readonly number[]) => boolean
}

const V4_RANGES: readonly Range[] = [
	{ reason: 'loopback', matches: (o) => o[0] === 127 },
	{ reason: 'this-host', matches: (o) => o[0] === 0 },
	{ reason: 'private', matches: (o) => o[0] === 10 },
	{ reason: 'private', matches: (o) => o[0] === 172 && (o[1] ?? 0) >= 16 && (o[1] ?? 0) <= 31 },
	{ reason: 'private', matches: (o) => o[0] === 192 && o[1] === 168 },
	// 169.254.0.0/16. The metadata address every major host platform answers
	// on lives here, which is why this range is the one that turns a name
	// check into a credential leak.
	{ reason: 'link-local', matches: (o) => o[0] === 169 && o[1] === 254 },
	{
		reason: 'shared-address-space',
		matches: (o) => o[0] === 100 && (o[1] ?? 0) >= 64 && (o[1] ?? 0) <= 127,
	},
	{ reason: 'benchmarking', matches: (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19) },
	{ reason: 'multicast', matches: (o) => (o[0] ?? 0) >= 224 && (o[0] ?? 0) <= 239 },
	{ reason: 'reserved', matches: (o) => (o[0] ?? 0) >= 240 },
]

function parseV4(address: string): readonly number[] | null {
	const parts = address.split('.')
	if (parts.length !== 4) return null
	const octets: number[] = []
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null
		const n = Number(part)
		if (n > 255) return null
		octets.push(n)
	}
	return octets
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or `null`.
 *
 * Written out rather than pattern-matched on the text, because a prefix
 * matched as a STRING is a different question from a prefix matched as a
 * NUMBER, and the two disagree exactly where it hurts. `/^f[cd]/` was the
 * first spelling of the unique-local check here, and `fd::1` matches it —
 * but `fd::1` is `00fd:0:…`, an ordinary global address, so that check
 * deleted a slice of the internet. `fe8::1` did the same against
 * `/^fe[89ab]/`. Both are the `>=`-where-`>`-was-meant mistake wearing a
 * regex.
 *
 * It fails the other way too. `0:0:0:0:0:ffff:169.254.169.254` is the
 * metadata address written long, and no `^::`-anchored pattern sees it.
 */
function parseV6(address: string): number[] | null {
	// A zone id (`%eth0`) names an interface, not a different address.
	const text = (address.toLowerCase().split('%')[0] ?? '').trim()
	if (text.length === 0) return null

	// A trailing dotted quad is the last two groups written in v4 notation.
	let head = text
	let tail: number[] = []
	const lastColon = text.lastIndexOf(':')
	const after = lastColon >= 0 ? text.slice(lastColon + 1) : ''
	if (after.includes('.')) {
		const quad = parseV4(after)
		if (!quad) return null
		const [a, b, c, d] = quad as [number, number, number, number]
		tail = [(a << 8) | b, (c << 8) | d]
		head = text.slice(0, lastColon + 1)
		if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1)
	}

	const halves = head.split('::')
	if (halves.length > 2) return null

	const toGroups = (part: string): number[] | null => {
		if (part.length === 0) return []
		const out: number[] = []
		for (const piece of part.split(':')) {
			if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
			out.push(Number.parseInt(piece, 16))
		}
		return out
	}

	if (halves.length === 1) {
		const only = toGroups(halves[0] ?? '')
		if (!only) return null
		const groups = [...only, ...tail]
		return groups.length === 8 ? groups : null
	}

	const left = toGroups(halves[0] ?? '')
	const right = toGroups(halves[1] ?? '')
	if (!left || !right) return null
	const known = left.length + right.length + tail.length
	if (known > 8) return null
	return [...left, ...new Array<number>(8 - known).fill(0), ...right, ...tail]
}

/** Whether the first `count` groups are all zero. */
function zeroPrefix(groups: readonly number[], count: number): boolean {
	return groups.slice(0, count).every((g) => g === 0)
}

/**
 * Why this address must not be reached, or `null` if it may be.
 *
 * Returns a reason rather than a boolean because the reason is what a
 * denied operator needs: "link-local" and "private" are different mistakes
 * with different fixes, and a bare `false` sends them to read this file.
 */
export function blockedAddressReason(address: string): string | null {
	const literal = unbracket(address)
	const v4 = parseV4(literal)
	if (v4) {
		for (const range of V4_RANGES) {
			if (range.matches(v4)) return range.reason
		}
		return null
	}

	const groups = parseV6(literal)
	if (!groups) return null

	// `::ffff:a.b.c.d` (v4-mapped) and the deprecated `::a.b.c.d`
	// (v4-compatible) are both the v4 address wearing a v6 spelling, and both
	// reach the v4 host. A screen that only understands dotted quads passes
	// them, which is a documented way through this kind of filter rather than
	// an oversight worth ignoring.
	if (zeroPrefix(groups, 5) && groups[5] === 0xffff) {
		return blockedAddressReason(v4FromGroups(groups))
	}
	if (zeroPrefix(groups, 6) && !(groups[6] === 0 && (groups[7] ?? 0) <= 1)) {
		return blockedAddressReason(v4FromGroups(groups))
	}

	if (zeroPrefix(groups, 7)) {
		if (groups[7] === 1) return 'loopback'
		if (groups[7] === 0) return 'unspecified'
	}

	const first = groups[0] ?? 0
	// Masked, not prefix-matched: fc00::/7, fe80::/10, ff00::/8.
	if ((first & 0xfe00) === 0xfc00) return 'unique-local'
	if ((first & 0xffc0) === 0xfe80) return 'link-local'
	if ((first & 0xff00) === 0xff00) return 'multicast'
	return null
}

function v4FromGroups(groups: readonly number[]): string {
	const high = groups[6] ?? 0
	const low = groups[7] ?? 0
	return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * An IPv6 literal arrives bracketed from one of the two paths.
 *
 * `new URL('http://[::1]/').hostname` is `[::1]`, brackets included, and
 * `parseTarget` reads exactly that. The `Host`-header path hands the same
 * address over bare, because `splitAuthority` strips the brackets itself —
 * two spellings of one address, normalised here rather than at either call
 * site.
 *
 * This is a layer, not a hole closed, and the difference was measured rather
 * than assumed: Node does not read a bracketed string as an IP literal
 * either, so without this the host falls through to `dns.lookup` and the
 * screening resolver refuses it there. What this buys is that
 * `blockedLiteralReason` stops answering `null` about an address it plainly
 * recognises — a true-looking answer the next caller would build on.
 */
function unbracket(host: string): string {
	const trimmed = host.trim()
	return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
}

/**
 * Screen a target that is already an address rather than a name.
 *
 * A `lookup` hook cannot cover this case and it is not obvious why: the
 * socket layer skips resolution entirely when the host is a valid IP
 * literal, so the screening resolver is never called. The whole existing
 * egress suite passed with the resolver in place *because* its upstream is
 * `127.0.0.1` — a literal, never resolved, never screened. A green suite
 * was the evidence the hole was still open.
 *
 * So the two cases need two checks: names are screened inside the resolver
 * the socket calls, literals are screened here before it dials.
 */
export function blockedLiteralReason(host: string): string | null {
	// The `isIP` guard states the contract: only an address is screened here.
	//
	// It is defence in depth rather than the thing that saves a hostname, and
	// that was measured — removing it kills no test, because `parseV6` refuses
	// `fdsomething.example` and `ff-cdn.example` on its own. It earns its place
	// against the version of this file that does not: the first screen written
	// here matched `/^f[cd]/` against the raw text, and under that screen this
	// line was the only thing standing between an ordinary CDN hostname and a
	// refusal. Keeping it means a future loosening of the parser cannot quietly
	// turn an address screen back into a name filter.
	if (isIP(unbracket(host)) === 0) return null
	return blockedAddressReason(host)
}

export class EgressAddressDenied extends Error {
	readonly host: string
	readonly address: string
	readonly reason: string

	constructor(host: string, address: string, reason: string) {
		super(
			`Egress denied: ${host} resolves to ${address}, which is a ${reason} address. The host is on the allowlist; the address it resolves to is not reachable from a sandbox.`,
		)
		this.name = 'EgressAddressDenied'
		this.host = host
		this.address = address
		this.reason = reason
	}
}

export interface ScreeningLookupOptions {
	/**
	 * Hosts permitted to resolve inward anyway, matched by the allowlist's
	 * own rules so `.internal.example` covers subdomains.
	 *
	 * Per host, never a global switch. An operator who genuinely proxies to
	 * one service on a private network needs that service exempted, and
	 * turning the screen off entirely to get it would hand every other
	 * allowlisted name the same reach.
	 */
	readonly allowInwardFor?: readonly string[]
	/** Injected in tests. Defaults to the platform resolver. */
	readonly resolve?: AddressResolver
}

/**
 * The one shape this module asks a resolver for: every address, in the
 * order the resolver returned them.
 *
 * Narrower than the platform signature on purpose. The screen has to see
 * ALL the addresses to be worth anything, so a resolver that can be asked
 * for one is a resolver this code could accidentally ask wrongly.
 */
export type AddressResolver = (
	hostname: string,
	options: { readonly all: true; readonly verbatim: true },
	callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void

const platformResolver: AddressResolver = (hostname, options, callback) => {
	dnsLookup(hostname, options, callback)
}

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number,
) => void

/**
 * A `lookup` implementation that screens before the socket uses the answer.
 *
 * This is deliberately not "resolve, check, then connect to the address we
 * checked". That shape leaves the socket free to resolve again, and the
 * second answer is the one that decides where the bytes go — so a name that
 * alternates records walks straight through a check that passed a moment
 * earlier. Screening inside the resolver the socket itself calls means there
 * is one resolution, and the address that was screened is the address that
 * gets connected to.
 *
 * Every returned address is screened, not just the one chosen. A record set
 * mixing a public address with an inward one is the ordinary shape of this
 * attack, and screening only the winner makes the outcome depend on which
 * record the resolver happened to order first.
 */
export function createScreeningLookup(
	options: ScreeningLookupOptions = {},
	isExempt: (host: string, patterns: readonly string[]) => boolean = () => false,
): (hostname: string, opts: unknown, callback: LookupCallback) => void {
	const resolver = options.resolve ?? platformResolver
	const exemptions = options.allowInwardFor ?? []

	return (hostname, opts, callback) => {
		const wantsAll =
			typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all === true
		const family =
			typeof opts === 'number'
				? opts
				: typeof opts === 'object' && opts !== null
					? ((opts as { family?: number }).family ?? 0)
					: 0

		resolver(hostname, { all: true, verbatim: true }, (err, addresses) => {
			if (err) {
				callback(err, '', 0)
				return
			}
			const found = addresses ?? []
			if (found.length === 0) {
				const empty: NodeJS.ErrnoException = new Error(
					`Egress denied: ${hostname} resolved to no addresses.`,
				)
				empty.code = 'ENOTFOUND'
				callback(empty, '', 0)
				return
			}

			if (!(exemptions.length > 0 && isExempt(hostname, exemptions))) {
				for (const candidate of found) {
					const reason = blockedAddressReason(candidate.address)
					if (reason) {
						callback(new EgressAddressDenied(hostname, candidate.address, reason), '', 0)
						return
					}
				}
			}

			const usable = family === 0 ? found : found.filter((a) => a.family === family)
			if (usable.length === 0) {
				const mismatch: NodeJS.ErrnoException = new Error(
					`Egress denied: ${hostname} has no address in the requested family.`,
				)
				mismatch.code = 'ENOTFOUND'
				callback(mismatch, '', 0)
				return
			}

			if (wantsAll) {
				callback(null, usable)
				return
			}
			const first = usable[0]
			if (!first) {
				const none: NodeJS.ErrnoException = new Error(
					`Egress denied: ${hostname} resolved to no usable address.`,
				)
				none.code = 'ENOTFOUND'
				callback(none, '', 0)
				return
			}
			callback(null, first.address, first.family)
		})
	}
}
