import { homedir } from 'node:os'
import nodePath from 'node:path'

import stringWidth from 'string-width'

import { PROVIDER_REGISTRY, VENDOR_NAMES } from '../integrations/providers/registry.js'
import type { ProviderId } from '../integrations/providers/registry.js'

/**
 * The words the terminal app uses for its own concepts, in one place.
 *
 * The kernel's names (turn, session, checkpoint, compaction, host, ingress,
 * usage accounting) are developer vocabulary. A person using the app says
 * "reply", "conversation" and "summarising the conversation". Messages that a
 * person reads take their nouns from here, so a concept has one name
 * everywhere and a rename is one edit.
 *
 * Machine-readable output (`--json`, `exec`, the ACP host, logs) keeps the
 * kernel's names; this glossary is for the interactive surface only.
 */
export const TERMS = Object.freeze({
	/** One model answer, with the tool steps inside it. */
	reply: 'reply',
	/** What the kernel calls a session. */
	conversation: 'conversation',
	/** What the kernel calls compaction. */
	summarising: 'summarising the conversation',
	/** This computer, where the kernel says "host". */
	thisComputer: 'on this computer',
	/** How a person starts the app and resumes a conversation. */
	command: 'namzu',
} as const)

/** `1 message`, `2 messages`. Never `message(s)`. */
export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
}

/** `20s`, `1m 05s`, `2h 03m`. Never milliseconds. */
export function formatSpan(ms: number): string {
	const seconds = Math.max(1, Math.ceil(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
	const hours = Math.floor(minutes / 60)
	return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** One figure of a size: a decimal under ten (`7.5`), a whole number from ten up (`48`). */
function figure(value: number): number {
	return value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
}

/** `512 B`, `7.5 KB`, `48 KB`, `1.2 MB`: one format everywhere, with a space. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
	const kilobytes = figure(bytes / 1024)
	if (kilobytes < 1024) return `${kilobytes} KB`
	const megabytes = figure(bytes / (1024 * 1024))
	if (megabytes < 1024) return `${megabytes} MB`
	return `${figure(bytes / (1024 * 1024 * 1024))} GB`
}

/** The product name a person knows a provider by, from the provider registry. */
export function productName(providerId: string | undefined): string | undefined {
	const id = providerId?.trim()
	if (!id) return undefined
	const entry = Object.hasOwn(PROVIDER_REGISTRY, id)
		? PROVIDER_REGISTRY[id as ProviderId]
		: undefined
	const full = entry ? VENDOR_NAMES[entry.vendor] : undefined
	if (full) return full.replace(/\s*\(.*\)\s*$/, '')
	return id.charAt(0).toUpperCase() + id.slice(1)
}

/** The part of a path module a spelling depends on; injectable so both can be tested anywhere. */
export type PathFlavor = Pick<typeof nodePath, 'sep'>

/**
 * A path with the home folder written as `~`, so it stays short and private,
 * spelled with the platform's separator: `~\Work\app` on Windows, `~/work/app`
 * elsewhere. `flavor` is the path module whose separator to use.
 */
export function homePath(
	path: string,
	home: string = homedir(),
	flavor: PathFlavor = nodePath,
): string {
	const windows = flavor.sep === '\\'
	const normalized = path.replaceAll('\\', '/')
	const base = home.replaceAll('\\', '/').replace(/\/$/, '')
	const same = (a: string, b: string): boolean =>
		windows ? a.toLowerCase() === b.toLowerCase() : a === b
	const inHome =
		base !== '' &&
		(same(normalized, base) || same(normalized.slice(0, base.length + 1), `${base}/`))
	const shown = inHome ? `~${normalized.slice(base.length)}` : path
	return windows ? shown.replaceAll('/', '\\') : shown
}

/**
 * A path for a sentence: `~` for home, and when it is longer than `max` cells,
 * a middle ellipsis that keeps the first segment and the last folder whole
 * (`~/…/packages/cli`). The leaf is what says where you are, so it is dropped
 * last; only a leaf wider than `max` on its own is cut, from its start.
 */
export function displayPath(
	path: string,
	max: number,
	home: string = homedir(),
	flavor: PathFlavor = nodePath,
): string {
	const shown = homePath(path, home, flavor)
	if (max <= 0) return ''
	if (stringWidth(shown) <= max) return shown
	const sep = flavor.sep === '\\' || (shown.includes('\\') && !shown.includes('/')) ? '\\' : '/'
	const parts = shown.split(sep)
	const head = parts[0] === '~' || /^[A-Za-z]:$/.test(parts[0] ?? '') ? (parts[0] ?? '') : ''
	const rest = head ? parts.slice(1) : parts.filter((part, i) => part !== '' || i === 0).slice(1)
	const lead = head ? `${head}${sep}…` : '…'
	// Keep as many trailing folders as fit beside the lead and an ellipsis.
	for (let keep = rest.length; keep >= 1; keep--) {
		const tail = rest.slice(-keep).join(sep)
		const candidate = keep === rest.length && head ? `${head}${sep}${tail}` : `${lead}${sep}${tail}`
		if (stringWidth(candidate) <= max) return candidate
	}
	const leaf = rest[rest.length - 1] ?? shown
	const bare = `…${sep}${leaf}`
	if (stringWidth(bare) <= max) return bare
	return max === 1 ? '…' : `…${lastCells(leaf, max - 1)}`
}

/** The longest end of `text` that fits in `cells` display cells, never splitting a character. */
function lastCells(text: string, cells: number): string {
	const chars = Array.from(text)
	let used = 0
	let from = chars.length
	while (from > 0) {
		const width = stringWidth(chars[from - 1] ?? '')
		if (used + width > cells) break
		used += width
		from--
	}
	return chars.slice(from).join('')
}

/**
 * `host:port` when a provider's endpoint is on this computer or its local
 * network (localhost, a loopback or private address, a `.local` name), else
 * undefined. A local server that is down is not an internet problem, and the
 * message says where Namzu looked. `baseUrl` wins over the provider's default.
 */
export function localEndpoint(
	providerId: string | undefined,
	baseUrl?: string,
): string | undefined {
	const id = providerId?.trim()
	const entry =
		id && Object.hasOwn(PROVIDER_REGISTRY, id) ? PROVIDER_REGISTRY[id as ProviderId] : undefined
	const raw = baseUrl?.trim() || entry?.defaultBaseUrl
	if (!raw) return undefined
	let url: URL
	try {
		url = new URL(raw.includes('://') ? raw : `http://${raw}`)
	} catch {
		return undefined
	}
	const host = url.hostname
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '')
		.toLowerCase()
	if (!isLocalHost(host)) return undefined
	const shownHost = host.includes(':') ? `[${host}]` : host
	return url.port ? `${shownHost}:${url.port}` : shownHost
}

function isLocalHost(host: string): boolean {
	// A name with no dot ("gpu-box") resolves on the local network, never on the internet.
	if (host.length > 0 && !host.includes('.') && !host.includes(':')) return true
	if (/^::ffff:7f[0-9a-f]{2}:/.test(host)) return true
	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
	if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host))
		return true
	const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!v4) return false
	const [a, b] = [Number(v4[1]), Number(v4[2])]
	return (
		a === 127 ||
		a === 10 ||
		a === 0 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127)
	)
}

/** The short form of a conversation id, for places where a whole UUID is noise. */
export function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id
}
