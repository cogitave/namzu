/**
 * What the Browser pane may open, as pure rules with no Electron in them.
 *
 * A web address (http or https) is open to the whole web, as in any browser. A local file is open
 * only when it sits inside the conversation's work folder, so a page the conversation wrote can be
 * shown, and a page cannot be used to read the rest of the disk. Everything else is refused.
 */

export type AddressResult = { ok: true; url: string } | { ok: false; reason: string }

const DRIVE = /^[A-Za-z]:\//
const REFUSED_FILE = 'Only files inside this conversation’s work folder can be opened here.'
const REFUSED_KIND = 'Type a web address, or a file in the work folder.'

/** A path with forward slashes only, dots resolved, and no trailing slash (a drive root keeps it). */
export function cleanPath(path: string): string {
	const slashes = path.replace(/\\/g, '/')
	const drive = DRIVE.test(slashes) ? slashes.slice(0, 2) : ''
	const rest = drive ? slashes.slice(2) : slashes
	const parts: string[] = []
	for (const part of rest.split('/')) {
		if (part === '' || part === '.') continue
		if (part === '..') parts.pop()
		else parts.push(part)
	}
	return `${drive}/${parts.join('/')}`
}

/** True for an absolute path of either kind: a drive letter, a share, or a leading slash. */
export function isAbsolutePath(path: string): boolean {
	return DRIVE.test(path.replace(/\\/g, '/')) || /^[\\/]/.test(path)
}

/** Whether `target` is `root` or below it. A drive's case is not compared when `caseless` is set. */
export function isInside(root: string, target: string, caseless: boolean): boolean {
	const fold = (value: string) => (caseless ? value.toLowerCase() : value)
	const base = fold(cleanPath(root))
	const path = fold(cleanPath(target))
	if (path === base) return true
	return path.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** The `file:` address of an absolute local path. */
export function fileUrl(path: string): string {
	const clean = cleanPath(path)
	const drive = DRIVE.test(clean)
	const parts = clean.split('/')
	const head = drive ? [parts[0]] : []
	const tail = (drive ? parts.slice(1) : parts).map(encodeURIComponent)
	return `file://${drive ? '/' : ''}${[...head, ...tail].join('/')}`
}

/** The local path a `file:` address names, with forward slashes; undefined for any other address. */
export function pathOfFileUrl(url: string): string | undefined {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return undefined
	}
	if (parsed.protocol !== 'file:') return undefined
	let path: string
	try {
		path = decodeURIComponent(parsed.pathname)
	} catch {
		return undefined
	}
	if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
	// A file on a network share keeps its host: \\host\share\file.
	if (parsed.host) path = `//${parsed.host}${path}`
	return path
}

/**
 * The text of an address bar: the whole local path for a file (`C:/Users/me/work/index.html`),
 * the address itself for a web page, and nothing for a blank tab.
 */
export function addressText(url: string): string {
	if (!url || url === 'about:blank') return ''
	return pathOfFileUrl(url) ?? url
}

export interface AddressRules {
	/** The conversation's work folder, or undefined when it has none. */
	workFolder: string | undefined
	/** Windows compares paths without regard to case. */
	caseless: boolean
}

/** Whether a `file:` address may be loaded under these rules. */
export function fileAllowed(url: string, rules: AddressRules): boolean {
	const path = pathOfFileUrl(url)
	return Boolean(path && rules.workFolder && isInside(rules.workFolder, path, rules.caseless))
}

/**
 * Reads what a person typed, or a path a turn wrote (`relative` allows a path from the work folder).
 * Returns the address to load, or the words to tell the person.
 */
export function resolveAddress(
	input: string,
	rules: AddressRules,
	options: { relative?: boolean } = {},
): AddressResult {
	const text = input.trim()
	if (!text || text.length > 4096) return { ok: false, reason: REFUSED_KIND }
	if (/^file:/i.test(text)) {
		const url = fileUrl(pathOfFileUrl(text) ?? '')
		return pathOfFileUrl(text) && fileAllowed(url, rules)
			? { ok: true, url }
			: { ok: false, reason: REFUSED_FILE }
	}
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)?.[1]
	const drivePath = DRIVE.test(text.replace(/\\/g, '/'))
	// "localhost:3000" has a colon but no scheme: a port follows it.
	const hostWithPort = /^[^/\s:]+:\d+([/?#]|$)/.test(text)
	if (scheme && !drivePath && !hostWithPort) {
		if (!/^https?$/i.test(scheme)) return { ok: false, reason: REFUSED_KIND }
		try {
			const parsed = new URL(text)
			return parsed.hostname ? { ok: true, url: parsed.href } : { ok: false, reason: REFUSED_KIND }
		} catch {
			return { ok: false, reason: REFUSED_KIND }
		}
	}
	const asPath = isAbsolutePath(text)
		? text
		: options.relative && rules.workFolder
			? `${rules.workFolder}/${text}`
			: undefined
	if (asPath !== undefined) {
		const url = fileUrl(asPath)
		return fileAllowed(url, rules) ? { ok: true, url } : { ok: false, reason: REFUSED_FILE }
	}
	// A bare host such as "example.com" or "localhost:3000" is a web address without its scheme.
	if (!/\s/.test(text) && /^(localhost|[^/\s]+\.[^/\s]+)(:\d+)?([/?#].*)?$/i.test(text)) {
		try {
			return { ok: true, url: new URL(`https://${text}`).href }
		} catch {
			return { ok: false, reason: REFUSED_KIND }
		}
	}
	return { ok: false, reason: REFUSED_KIND }
}

/**
 * The sites an agent's tabs may reach, as the engine compiled them from its own permission rules and
 * passed when the tab was opened. Each entry is a host (`example.com`), a host and everything under it
 * (`*.example.com`), or `*`. `deny` wins over `allow`; an empty or missing `allow` allows every host.
 */
export interface SiteRules {
	allow?: readonly string[]
	deny?: readonly string[]
}

function hostMatches(host: string, pattern: string): boolean {
	const entry = pattern.trim().toLowerCase()
	if (entry === '*') return true
	if (entry.startsWith('*.')) {
		const base = entry.slice(2)
		return host === base || host.endsWith(`.${base}`)
	}
	return host === entry
}

/** Whether a web address is open under the site rules. Files and blank pages are not a site. */
export function siteAllowed(url: string, sites: SiteRules | undefined): boolean {
	if (!sites) return true
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		return false
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
	if (sites.deny?.some((pattern) => hostMatches(host, pattern))) return false
	if (!sites.allow || sites.allow.length === 0) return true
	return sites.allow.some((pattern) => hostMatches(host, pattern))
}
