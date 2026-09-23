/**
 * `browser.sites`, compiled to the kernel's rule vocabulary.
 *
 * An operator writes one level per site:
 *
 * ```yaml
 * browser:
 *   sites:
 *     "https://github.com": act
 *     "https://*.example.com": read
 *     "*": ask
 * ```
 *
 * and the gate sees `argument_pattern` rules over the two arguments the
 * browser tools canonicalise: `browser.url` (the address a navigation loads)
 * and `browser_act.origin` (the page an action changes). The tools declare
 * `url` as a URL argument, so a rule tests it whole; the SDK's input schema
 * has already turned `HTTPS://GitHub.com.:443/x` into `https://github.com/x`,
 * so one spelling per site is enough.
 *
 * | Level  | `browser` navigate / tabs new | `browser_act` |
 * | ------ | ----------------------------- | ------------- |
 * | `deny` | deny                          | deny          |
 * | `read` | allow                         | deny          |
 * | `ask`  | review                        | review        |
 * | `act`  | allow                         | allow         |
 *
 * Order is the gate's first match: every `deny` first, then the other sites
 * from most to least specific (the same order `@namzu/browser`'s host policy
 * uses, so the gate and the host agree on which key decides), then `*`.
 * Looking at the page (`snapshot`, `screenshot`, `scroll`, `wait_for`, and
 * `tabs list|select|close`) is allowed: the browser tools are network tools,
 * which are reviewed even when read-only unless a rule allows them, and the
 * page being looked at is one the host already let stay loaded.
 *
 * The origin patterns are built here, from the SDK's canonical site key,
 * rather than from a glob: `https://github.com` must not match
 * `https://github.com.evil.example`, `https://evil.example/?https://github.com`
 * or `https://github.com:8443`.
 */

import {
	type AuthorizationRule,
	BROWSER_ACT_TOOL_NAME,
	BROWSER_TOOL_NAME,
	canonicalizeBrowserSitePattern,
	canonicalizeBrowserUrl,
} from '@namzu/sdk'

export type BrowserSiteLevel = 'deny' | 'read' | 'ask' | 'act'

/** Site key (`https://github.com`, `https://*.example.com`, `http://localhost:*`, `*`) to level. */
export type BrowserSitesConfig = Readonly<Record<string, BrowserSiteLevel>>

export const BROWSER_SITE_LEVELS: readonly BrowserSiteLevel[] = ['deny', 'read', 'ask', 'act']

/** What an unlisted site gets when `*` is not written. */
export const DEFAULT_BROWSER_SITE_LEVEL: BrowserSiteLevel = 'ask'

export function isBrowserSiteLevel(value: unknown): value is BrowserSiteLevel {
	return typeof value === 'string' && (BROWSER_SITE_LEVELS as readonly string[]).includes(value)
}

export type BrowserSiteKeyVerdict =
	| { readonly ok: true; readonly key: string }
	| { readonly ok: false; readonly reason: string }

/** A site key as the gate and the host read it: `*`, or the SDK's canonical pattern. */
export function canonicalBrowserSiteKey(raw: string): BrowserSiteKeyVerdict {
	if (raw.trim() === '*') return { ok: true, key: '*' }
	const verdict = canonicalizeBrowserSitePattern(raw)
	return verdict.ok ? { ok: true, key: verdict.pattern } : { ok: false, reason: verdict.reason }
}

interface ParsedSite {
	readonly key: string
	readonly level: BrowserSiteLevel
	readonly scheme: string
	/** Exact host, or the suffix after `*.`. */
	readonly host: string
	readonly wildcardHost: boolean
	/** `*`, an explicit port, or '' for the scheme's default port. */
	readonly port: string
}

function parseSite(key: string, level: BrowserSiteLevel): ParsedSite | undefined {
	const match = /^(https?):\/\/(\*\.)?([^:]+)(?::(\*|\d+))?$/.exec(key)
	if (!match) return undefined
	return {
		key,
		level,
		scheme: match[1] ?? '',
		host: match[3] ?? '',
		wildcardHost: match[2] !== undefined,
		port: match[4] ?? '',
	}
}

/** Higher is more specific: exact host over wildcard, longer suffix first, exact port over `*`. */
function specificity(site: ParsedSite): number {
	return (site.wildcardHost ? 0 : 1_000_000) + site.host.length * 10 + (site.port === '*' ? 0 : 1)
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The regex source (unanchored) that matches exactly the canonical origins
 * a site key names. `*.` is one or more whole labels; `:*` is any port or
 * none; no port is the scheme's default only, which the canonical form
 * leaves out.
 */
function originSource(site: ParsedSite): string {
	const host = site.wildcardHost
		? `(?:[^./:?#@\\[\\]]+\\.)+${escapeRegExp(site.host)}`
		: escapeRegExp(site.host)
	const port = site.port === '*' ? '(?::\\d{1,5})?' : site.port === '' ? '' : `:${site.port}`
	return `${site.scheme}://${host}${port}`
}

type Decision = 'allow' | 'deny' | 'review'

const NAVIGATE: Record<BrowserSiteLevel, Decision> = {
	deny: 'deny',
	read: 'allow',
	ask: 'review',
	act: 'allow',
}

const ACT: Record<BrowserSiteLevel, Decision> = {
	deny: 'deny',
	read: 'deny',
	ask: 'review',
	act: 'allow',
}

function rulesFor(origin: string | undefined, level: BrowserSiteLevel): AuthorizationRule[] {
	// `*`: any value. `^` alone matches every string the argument can hold.
	const url = origin === undefined ? '^' : `^${origin}(?:[/?#]|$)`
	const act = origin === undefined ? '^' : `^${origin}$`
	return [
		{
			type: 'argument_pattern',
			toolNames: [BROWSER_TOOL_NAME],
			argument: 'url',
			pattern: url,
			decision: NAVIGATE[level],
		},
		{
			type: 'argument_pattern',
			toolNames: [BROWSER_ACT_TOOL_NAME],
			argument: 'origin',
			pattern: act,
			decision: ACT[level],
		},
	]
}

/**
 * Looking at the page the browser holds. These calls carry no address; the
 * host only ever holds a page the site rules let stay (or `about:blank`).
 * `tabs new` carries a `url` and is decided by the site rules instead.
 */
const LOOKING: readonly AuthorizationRule[] = [
	{
		type: 'argument_pattern',
		toolNames: [BROWSER_TOOL_NAME],
		argument: 'action',
		pattern: '^(?:snapshot|screenshot|scroll|wait_for)$',
		decision: 'allow',
	},
	{
		type: 'argument_pattern',
		toolNames: [BROWSER_TOOL_NAME],
		argument: 'op',
		pattern: '^(?:list|select|close)$',
		decision: 'allow',
	},
]

export interface CompiledBrowserSites {
	readonly rules: readonly AuthorizationRule[]
	/** The sites as compiled: canonical keys, `*` always present. */
	readonly sites: BrowserSitesConfig
	/** Entries that could not be compiled. The config reader refuses these first; this is the backstop. */
	readonly diagnostics: readonly string[]
}

/** Canonical keys, `*` filled in, unreadable entries reported. */
export function normalizeBrowserSites(sites: BrowserSitesConfig | undefined): {
	readonly sites: BrowserSitesConfig
	readonly diagnostics: readonly string[]
} {
	const out: Record<string, BrowserSiteLevel> = {}
	const diagnostics: string[] = []
	for (const [raw, level] of Object.entries(sites ?? {})) {
		if (!isBrowserSiteLevel(level)) {
			diagnostics.push(`browser.sites."${raw}": use deny, read, ask or act`)
			continue
		}
		const verdict = canonicalBrowserSiteKey(raw)
		if (!verdict.ok) {
			diagnostics.push(`browser.sites."${raw}": ${verdict.reason}`)
			continue
		}
		const existing = out[verdict.key]
		// The same site written twice (`https://GitHub.com` and
		// `https://github.com`): the narrower level holds, so a spelling can
		// never widen what another spelling said.
		out[verdict.key] = existing === undefined ? level : narrower(existing, level)
	}
	if (out['*'] === undefined) out['*'] = DEFAULT_BROWSER_SITE_LEVEL
	return { sites: out, diagnostics }
}

/** The narrower of two levels: `deny`, then `read`, then `ask`, then `act`. */
export function narrower(a: BrowserSiteLevel, b: BrowserSiteLevel): BrowserSiteLevel {
	return BROWSER_SITE_LEVELS.indexOf(a) <= BROWSER_SITE_LEVELS.indexOf(b) ? a : b
}

/** Compile `browser.sites` into gate rules, in the order the gate must try them. */
export function compileBrowserSites(sites: BrowserSitesConfig | undefined): CompiledBrowserSites {
	const normalized = normalizeBrowserSites(sites)
	const diagnostics = [...normalized.diagnostics]
	const parsed: ParsedSite[] = []
	for (const [key, level] of Object.entries(normalized.sites)) {
		if (key === '*') continue
		const site = parseSite(key, level)
		if (site) parsed.push(site)
		else diagnostics.push(`browser.sites."${key}": could not be read`)
	}
	const denies = parsed.filter((site) => site.level === 'deny')
	const others = parsed
		.filter((site) => site.level !== 'deny')
		.sort((a, b) => specificity(b) - specificity(a) || (a.key < b.key ? -1 : 1))
	const rules: AuthorizationRule[] = [
		// A blank tab is where the browser starts; it loads nothing.
		{
			type: 'argument_pattern',
			toolNames: [BROWSER_TOOL_NAME],
			argument: 'url',
			pattern: '^about:blank$',
			decision: 'allow',
		},
		...denies.flatMap((site) => rulesFor(originSource(site), 'deny')),
		...others.flatMap((site) => rulesFor(originSource(site), site.level)),
		...rulesFor(undefined, normalized.sites['*'] ?? DEFAULT_BROWSER_SITE_LEVEL),
		...LOOKING,
	]
	return { rules, sites: normalized.sites, diagnostics }
}

const BROWSER_TOOLS = new Set<string>([BROWSER_TOOL_NAME, BROWSER_ACT_TOOL_NAME])

/** A `[permissions]` rule that denies a browser tool, which the site rules must not get ahead of. */
function isBrowserDeny(rule: AuthorizationRule): boolean {
	switch (rule.type) {
		case 'deny_by_name':
			return rule.toolNames.some((name) => BROWSER_TOOLS.has(name))
		case 'argument_pattern':
			return rule.decision === 'deny' && rule.toolNames.some((name) => BROWSER_TOOLS.has(name))
		case 'custom_pattern':
			return (
				rule.decision === 'deny' &&
				(rule.pattern.startsWith(`^${BROWSER_TOOL_NAME}`) ||
					rule.pattern.startsWith(`^${BROWSER_ACT_TOOL_NAME}`))
			)
		default:
			return false
	}
}

/**
 * The session's rules with the site rules in them: a `[permissions]` deny
 * that names a browser tool first (it still wins), then the site rules, then
 * the rest of the table. An `allow` or `ask` for `browser` in the table is
 * reached only by a call no site rule decided (`back`, `forward`, `reload`).
 */
export function withBrowserSiteRules(
	tableRules: readonly AuthorizationRule[],
	siteRules: readonly AuthorizationRule[],
): AuthorizationRule[] {
	return [
		...tableRules.filter(isBrowserDeny),
		...siteRules,
		...tableRules.filter((rule) => !isBrowserDeny(rule)),
	]
}

/**
 * Which key of `sites` decides `origin`, and at what level: a matching
 * `deny` first, else the most specific match, else `*`. The same answer the
 * compiled rules give; used to show the rule on the review screen.
 */
export function browserSiteRuleFor(
	sites: BrowserSitesConfig,
	origin: string,
): { readonly site: string; readonly level: BrowserSiteLevel } {
	const normalized = normalizeBrowserSites(sites).sites
	const parsed = Object.entries(normalized)
		.filter(([key]) => key !== '*')
		.map(([key, level]) => parseSite(key, level))
		.filter((site): site is ParsedSite => site !== undefined)
	const hits = parsed.filter((site) => new RegExp(`^${originSource(site)}$`).test(origin))
	const deny = hits.find((site) => site.level === 'deny')
	if (deny) return { site: deny.key, level: 'deny' }
	const best = hits.sort((a, b) => specificity(b) - specificity(a))[0]
	if (best) return { site: best.key, level: best.level }
	return { site: '*', level: normalized['*'] ?? DEFAULT_BROWSER_SITE_LEVEL }
}

/**
 * The origin a browser call opens or acts on, canonical, or `undefined` for
 * one that names none (`snapshot`, `back`, …).
 */
export function browserCallOrigin(toolName: string, input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null) return undefined
	const record = input as Record<string, unknown>
	if (toolName === BROWSER_ACT_TOOL_NAME) {
		return typeof record.origin === 'string' ? record.origin : undefined
	}
	if (toolName === BROWSER_TOOL_NAME && typeof record.url === 'string') {
		const verdict = canonicalizeBrowserUrl(record.url)
		return verdict.ok && verdict.url !== 'about:blank' ? verdict.origin : undefined
	}
	return undefined
}
