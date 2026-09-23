import { canonicalizeBrowserSitePattern, canonicalizeBrowserUrl } from '@namzu/sdk'

/**
 * What a site may be used for.
 *
 * - `deny`: not opened, not acted on; a page that lands there is cleared.
 * - `read`: opened and read without asking; never acted on.
 * - `ask`: opening and acting are for the gate to review; the host lets a
 *   call through (it was approved to reach the host) but a redirect or popup
 *   that lands there unasked is cleared.
 * - `act`: opened, read and acted on without asking.
 */
export type BrowserSiteLevel = 'deny' | 'read' | 'ask' | 'act'

/** Site key (`https://github.com`, `https://*.example.com`, `http://localhost:*`, `*`) to level. */
export type BrowserSiteRules = Readonly<Record<string, BrowserSiteLevel>>

/** The rules a host applies when its caller gives none. */
export const DEFAULT_BROWSER_SITE_RULES: BrowserSiteRules = { '*': 'ask' }

const LEVELS: readonly BrowserSiteLevel[] = ['deny', 'read', 'ask', 'act']

interface CompiledRule {
	readonly key: string
	readonly level: BrowserSiteLevel
	readonly scheme: string
	/** Exact host, or the suffix after `*.`. */
	readonly host: string
	readonly wildcardHost: boolean
	/** `*`, an explicit port, or '' for the scheme's default port. */
	readonly port: string
}

export class BrowserSitePolicyError extends Error {
	override readonly name = 'BrowserSitePolicyError'
}

/** A landing the policy refused, and why, in the host's words. */
export interface BrowserLandingVerdict {
	readonly allowed: boolean
	/** Canonical origin, `about:blank`, or the scheme for a non-web address. */
	readonly origin: string
	readonly reason?: string
}

function compile(key: string, level: BrowserSiteLevel): CompiledRule {
	if (!LEVELS.includes(level)) {
		throw new BrowserSitePolicyError(
			`site rule "${key}" has level "${String(level)}"; use deny, read, ask or act`,
		)
	}
	const verdict = canonicalizeBrowserSitePattern(key)
	if (!verdict.ok) throw new BrowserSitePolicyError(`site rule "${key}": ${verdict.reason}`)
	const match = /^(https?):\/\/(\*\.)?([^:]+)(?::(\*|\d+))?$/.exec(verdict.pattern)
	if (!match) throw new BrowserSitePolicyError(`site rule "${key}" could not be read`)
	return {
		key: verdict.pattern,
		level,
		scheme: match[1] ?? '',
		host: match[3] ?? '',
		wildcardHost: match[2] !== undefined,
		port: match[4] ?? '',
	}
}

function matches(rule: CompiledRule, url: URL): boolean {
	if (url.protocol !== `${rule.scheme}:`) return false
	if (rule.port !== '*' && url.port !== rule.port) return false
	const host = url.hostname
	if (rule.wildcardHost) return host.endsWith(`.${rule.host}`)
	return host === rule.host
}

/** Higher is more specific: exact host over wildcard, longer suffix first, exact port over `*`. */
function specificity(rule: CompiledRule): number {
	return (rule.wildcardHost ? 0 : 1_000_000) + rule.host.length * 10 + (rule.port === '*' ? 0 : 1)
}

/**
 * The host-side site policy: the check after the fact.
 *
 * The gate decides whether a call may run; this decides whether the page the
 * browser actually ended up on may stay loaded, and whether the live page may
 * be acted on. A navigation the gate approved can redirect, a click can open
 * a popup, and a script can move the tab — none of which the gate saw.
 *
 * Matching: every `deny` that matches wins; otherwise the most specific
 * matching key; otherwise `*`; otherwise `ask`.
 */
export class BrowserSitePolicy {
	private readonly rules: readonly CompiledRule[]
	private readonly fallback: BrowserSiteLevel
	private readonly approved = new Set<string>()

	constructor(sites: BrowserSiteRules = DEFAULT_BROWSER_SITE_RULES) {
		const rules: CompiledRule[] = []
		let fallback: BrowserSiteLevel = 'ask'
		for (const [key, level] of Object.entries(sites)) {
			if (key.trim() === '*') {
				if (!LEVELS.includes(level)) {
					throw new BrowserSitePolicyError(
						`site rule "*" has level "${String(level)}"; use deny, read, ask or act`,
					)
				}
				fallback = level
				continue
			}
			rules.push(compile(key, level))
		}
		this.rules = rules.sort((a, b) => specificity(b) - specificity(a))
		this.fallback = fallback
	}

	/** The level of a canonical origin (`https://github.com`). */
	levelOf(origin: string): BrowserSiteLevel {
		let url: URL
		try {
			url = new URL(origin)
		} catch {
			return 'deny'
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'deny'
		const hits = this.rules.filter((rule) => matches(rule, url))
		if (hits.some((rule) => rule.level === 'deny')) return 'deny'
		return hits[0]?.level ?? this.fallback
	}

	/**
	 * Record that the caller asked to open `origin`. A call that reached the
	 * host passed the gate, so the page it names may stay loaded even when
	 * its level alone would need a review.
	 */
	approve(origin: string): void {
		this.approved.add(origin)
	}

	isApproved(origin: string): boolean {
		return this.approved.has(origin)
	}

	/** May the host act on a page at `origin`? `ask` and `act`: the gate has had its say. */
	canAct(origin: string): boolean {
		const level = this.levelOf(origin)
		return level === 'ask' || level === 'act'
	}

	/**
	 * May a page that a navigation, redirect or popup landed on stay loaded?
	 * `about:blank`, an origin at `read` or `act`, or one the caller asked to
	 * open this session; never a `deny`, never a non-web scheme, never a cloud
	 * metadata address.
	 */
	landing(rawUrl: string): BrowserLandingVerdict {
		if (rawUrl === 'about:blank' || rawUrl === '') return { allowed: true, origin: 'about:blank' }
		let parsed: URL
		try {
			parsed = new URL(rawUrl)
		} catch {
			return { allowed: false, origin: 'unknown', reason: 'the address could not be read' }
		}
		if (parsed.protocol === 'about:') {
			return parsed.href === 'about:blank' || parsed.href === 'about:srcdoc'
				? { allowed: true, origin: 'about:blank' }
				: { allowed: false, origin: 'about', reason: `${parsed.href} is not a web page` }
		}
		// A blob: document belongs to the page that made it; the origin inside decides.
		const inner = parsed.protocol === 'blob:' ? parsed.pathname : rawUrl
		const verdict = canonicalizeBrowserUrl(inner)
		if (!verdict.ok) {
			return {
				allowed: false,
				origin: parsed.protocol.replace(/:$/, ''),
				reason: verdict.reason,
			}
		}
		const origin = verdict.origin
		const level = this.levelOf(origin)
		if (level === 'deny') {
			return { allowed: false, origin, reason: `${origin} is denied by the site rules` }
		}
		if (level === 'read' || level === 'act' || this.approved.has(origin)) {
			return { allowed: true, origin }
		}
		return {
			allowed: false,
			origin,
			reason: `${origin} was not asked for and the site rules need approval to open it`,
		}
	}
}
