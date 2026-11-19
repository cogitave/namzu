import type { ExtensionFailure, ExtensionRow, ExtensionState } from '../shared/extensions-view.js'

/** The words and the small decisions of the Extensions page, apart from the screen so they can be tested as data. */

/** What a refusal means, in plain words. The engine's own message is the fallback. */
export function failureWords(failure: ExtensionFailure): string {
	switch (failure.code) {
		case 'untrusted-publisher':
			return failure.check === 'trusted-key' && /No trusted publisher keys/.test(failure.message)
				? 'This version of Namzu does not trust any extension publisher yet, so no extension can be added.'
				: 'This file was not signed by a publisher Namzu trusts.'
		case 'tampered':
			return 'This file was changed after it was signed. Nothing was added.'
		case 'engine':
			return failure.message.replace(/^This extension needs Namzu/, 'This extension needs Namzu')
		case 'platform':
			return 'This extension has no build for this computer.'
		case 'version':
			return failure.message
		case 'wording-changed':
			return 'This update changes what it tells you without raising its notice version, so it was refused.'
		case 'needs-license':
			return failure.message
		case 'stale-notice':
			return 'The notice changed while you were reading it. Read it again.'
		case 'bad-package':
			return `This is not a package Namzu can add (${failure.message.replace(/\.$/, '')}).`
		case 'manifest-invalid':
			return `This extension’s description is not valid: ${failure.message}`
		default:
			return failure.message || 'Something went wrong.'
	}
}

export interface CardAction {
	kind: 'enable' | 'license' | 'notice' | 'start-again' | 'disable' | 'review-update' | 'none'
	label: string
}

/** The quiet "Read the notice" link is left out when the main button already says exactly that. */
export const offersNoticeLink = (action: CardAction): boolean => action.kind !== 'notice'

/** The one main action a card offers for its state. */
export function mainAction(row: ExtensionRow): CardAction {
	if (row.updateWaiting && row.state !== 'failed')
		return { kind: 'review-update', label: 'Review and accept' }
	switch (row.state) {
		case 'added':
		case 'needs-license':
			return row.needs.includes('license')
				? { kind: 'license', label: 'Add a licence' }
				: { kind: 'enable', label: 'Enable' }
		case 'needs-notice':
			return { kind: 'notice', label: 'Read the notice' }
		case 'ready':
		case 'stopped':
			return { kind: 'enable', label: 'Enable' }
		case 'failed':
			return { kind: 'start-again', label: 'Start again' }
		case 'license-expired':
		case 'license-revoked':
			return { kind: 'license', label: 'Add a licence' }
		case 'license-grace':
			return { kind: 'disable', label: 'Disable' }
		case 'starting':
		case 'running':
		case 'not-responding':
			return { kind: 'disable', label: 'Disable' }
		default:
			return { kind: 'none', label: '' }
	}
}

/** The small "Read the notice" button is left out when the main button already says it. */
export function offersSecondaryNotice(action: CardAction): boolean {
	return action.kind !== 'notice'
}

export type ChipTone = 'good' | 'warn' | 'bad' | 'quiet'

export function chipTone(state: ExtensionState, degraded: boolean): ChipTone {
	if (state === 'running') return degraded ? 'warn' : 'good'
	if (
		state === 'starting' ||
		state === 'not-responding' ||
		state === 'update-waiting' ||
		state === 'license-grace'
	)
		return 'warn'
	if (state === 'failed' || state === 'license-expired' || state === 'license-revoked') return 'bad'
	return 'quiet'
}

/** One line for "kept N days". */
export function keptWords(days: number | 'keep'): string {
	if (days === 'keep') return 'Kept until your organisation deletes it.'
	return days === 1 ? 'Kept 1 day.' : `Kept ${days} days.`
}

/**
 * What an extension says it never collects, as one sentence. Each item is a fragment of its own, so they
 * are joined with semicolons and not run together; only the first keeps its capital.
 */
export function neverLine(items: readonly string[]): string {
	const parts = items
		.map((t) => t.trim().replace(/[.;\s]+$/, ''))
		.filter((t) => t.length > 0)
		.map((t, i) => {
			if (i === 0 || !/^[A-Z][a-z]/.test(t)) return t
			return t[0].toLowerCase() + t.slice(1)
		})
	return parts.length === 0 ? '' : `${parts.join('; ')}.`
}

export function formatWhen(iso: string, locale?: string): string {
	const t = Date.parse(iso)
	if (Number.isNaN(t)) return iso
	try {
		return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(t)
	} catch {
		return new Date(t).toISOString()
	}
}

export type NoticeBlock = { id: string; kind: 'h' | 'li' | 'p'; text: string }

/** The notice is Markdown written for a person: headings, list items and paragraphs, shown as plain text. */
export function noticeBlocks(markdown: string): NoticeBlock[] {
	const out: NoticeBlock[] = []
	let para: string[] = []
	const flush = () => {
		if (para.length) out.push({ id: `b${out.length}`, kind: 'p', text: para.join(' ') })
		para = []
	}
	for (const raw of markdown.replace(/<!--.*?-->/gs, '').split('\n')) {
		const line = raw.trim()
		if (!line) flush()
		else if (/^#{1,6}\s/.test(line)) {
			flush()
			out.push({ id: `b${out.length}`, kind: 'h', text: line.replace(/^#{1,6}\s+/, '') })
		} else if (/^\d+\.\s/.test(line)) {
			// A numbered item starts its own paragraph; it is not run into the one before it.
			flush()
			para.push(line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'))
		} else if (/^[-*]\s+/.test(line)) {
			flush()
			out.push({ id: `b${out.length}`, kind: 'li', text: line.replace(/^[-*]\s+/, '') })
		} else para.push(line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'))
	}
	flush()
	return out
}

/** True when the reader has reached the end of the text, or the text does not need scrolling at all. */
export function reachedEnd(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
	return scrollHeight <= clientHeight + 1 || scrollTop + clientHeight >= scrollHeight - 4
}

/** A counts answer shown as plain lines, whatever shape the extension gives it: only plain values, never markup. */
export function countLines(
	result: unknown,
	describe: (kind: string) => string | undefined = () => undefined,
): string[] {
	const lines: string[] = []
	const plain = (v: unknown): string | undefined =>
		typeof v === 'string'
			? v.slice(0, 120)
			: typeof v === 'number' || typeof v === 'boolean'
				? String(v)
				: undefined
	const one = (o: Record<string, unknown>): string => {
		const kind = plain(o.kind)
		const rest = Object.entries(o)
			.filter(([k]) => k !== 'kind')
			.flatMap(([k, v]) => {
				const p = plain(v)
				return p === undefined ? [] : [`${k} ${p}`]
			})
		return [kind, ...rest].filter(Boolean).join(': ')
	}
	if (result && typeof result === 'object' && !Array.isArray(result)) {
		const r = result as Record<string, unknown>
		const list = Array.isArray(r.counts) ? r.counts : undefined
		const kinds = Array.isArray(r.kinds) ? r.kinds : undefined
		if (kinds) {
			// The shape the activity extension answers with: how many records of each kind it holds today.
			for (const item of kinds.slice(0, 50)) {
				if (!item || typeof item !== 'object') continue
				const o = item as Record<string, unknown>
				const id = plain(o.id)
				const n = typeof o.rows === 'number' ? o.rows : undefined
				if (!id || n === undefined) continue
				lines.push(
					`${(describe(id) ?? id).replace(/[.!?…。]+$/, '')}: ${n === 0 ? 'nothing yet' : n === 1 ? '1 record' : `${n} records`}`,
				)
			}
		} else if (list) {
			for (const item of list.slice(0, 50))
				if (item && typeof item === 'object') lines.push(one(item as Record<string, unknown>))
		} else lines.push(one(r))
	}
	return lines.filter(Boolean)
}

export interface RowsTable {
	kind: string
	columns: string[]
	rows: string[][]
}

export function rowsTable(result: unknown): RowsTable | undefined {
	if (!result || typeof result !== 'object') return undefined
	const r = result as Record<string, unknown>
	if (typeof r.kind !== 'string' || !Array.isArray(r.columns) || !Array.isArray(r.rows))
		return undefined
	const columns = r.columns.filter((c): c is string => typeof c === 'string').slice(0, 24)
	const rows = r.rows
		.slice(0, 200)
		.map((row) =>
			Array.isArray(row)
				? row
						.slice(0, columns.length)
						.map((v) => (v === null || v === undefined ? '' : String(v).slice(0, 200)))
				: [],
		)
	return { kind: r.kind, columns, rows }
}

export const EXTENSIONS_INTRO =
	'Extensions are separate programs you add from a file. Each one lists what it asks for and why before it can run.'
export const EXTENSIONS_EMPTY =
	'An extension is a separate program you add from a file. Namzu shows what it asks for and why before it can run.'

/** What the licence block of a card says, from the facts only: nothing here is the extension's own text. */
export function licenceLines(row: ExtensionRow): string[] {
	if (row.licenceKind === 'none') return []
	const out: string[] = []
	if (row.licence)
		out.push(
			`${row.licence.customer}, ${row.licence.seats} ${row.licence.seats === 1 ? 'seat' : 'seats'}, valid until ${formatWhen(row.licence.expires)}`,
		)
	if (row.licenceKind === 'service' && row.licenceHost) {
		out.push(`Checked with ${row.licenceHost}`)
		if (row.licenceChecked)
			out.push(`Last checked ${formatWhen(new Date(row.licenceChecked.lastAt).toISOString())}`)
	}
	if (row.licenceGraceDaysLeft !== undefined)
		out.push(
			`The licence could not be checked. It keeps working for ${row.licenceGraceDaysLeft} ${row.licenceGraceDaysLeft === 1 ? 'more day' : 'more days'}.`,
		)
	if (row.state === 'license-revoked') out.push('The publisher withdrew this licence.')
	return out
}

/** The words for the "Start when I sign in" switch and what is true about it now. */
export function backgroundLines(
	row: ExtensionRow,
): { switchLabel: string; lines: string[] } | undefined {
	const b = row.background
	if (!b) return undefined
	const lines: string[] = []
	if (b.enabled)
		lines.push(
			b.hostedBy === 'runner'
				? 'Running in the background. It keeps running when Namzu is closed.'
				: b.hostedBy === 'app'
					? 'Running while Namzu is open.'
					: 'It starts when you sign in.',
		)
	lines.push(
		b.indicator === 'tray' && b.indicatorLabel
			? `While Namzu is closed it shows: ${b.indicatorLabel}`
			: 'It shows nothing of its own while Namzu is closed.',
	)
	if (b.signin?.disabledByOs)
		lines.push(
			'Your computer has switched off starting at sign-in for Namzu. It runs only while Namzu is open.',
		)
	else if (b.enabled && b.signin && !b.signin.registered && b.signin.reason)
		lines.push(`It could not be set to start at sign-in: ${b.signin.reason}`)
	return { switchLabel: 'Start when I sign in', lines }
}

export type PageEntry = {
	extensionId: string
	pageId: string
	title: string
	slot: 'sidebar' | 'settings' | 'panel'
	accent: string
	icon: string
	name: string
}

/** Every page the extensions drew for a slot: the sidebar entries, the settings pages, the panel. */
export function pageEntries(rows: readonly ExtensionRow[], slot: PageEntry['slot']): PageEntry[] {
	return rows.flatMap((r) =>
		r.ui && (r.state === 'running' || r.state === 'license-grace' || r.enabled)
			? r.ui.pages
					.filter((p) => p.slot === slot)
					.map((p) => ({
						extensionId: r.id,
						pageId: p.id,
						title: p.title,
						slot,
						accent: r.ui?.accent ?? '#808080',
						icon: r.ui?.icon ?? '',
						name: r.name,
					}))
			: [],
	)
}

export type StateTone = 'on' | 'off' | 'warn' | 'bad'

/**
 * The one word, with a dot, that says what an extension is doing. It is drawn in the extension's row
 * and on its own screen and nowhere else: not in the title bar and not on Namzu's tray icon. While it
 * runs, the word is the one the extension declared for its state (its chip), so a recorder can say
 * "Recording"; every other state is Namzu's own word.
 */
export function stateWord(row: ExtensionRow): { text: string; tone: StateTone } {
	if (row.updateWaiting && row.state !== 'failed') return { text: 'Update to review', tone: 'warn' }
	switch (row.state) {
		case 'running': {
			const chip = row.ui?.chips[0]
			const degraded = row.indicator?.level === 'warn'
			return {
				text: chip?.label ?? 'On',
				tone: degraded || chip?.tone === 'warn' ? 'warn' : 'on',
			}
		}
		case 'starting':
			return { text: 'Starting', tone: 'warn' }
		case 'not-responding':
			return { text: 'Not responding', tone: 'warn' }
		case 'failed':
			return { text: 'Stopped', tone: 'bad' }
		case 'needs-notice':
			return { text: 'Needs your notice', tone: 'warn' }
		case 'needs-license':
			return { text: 'Needs a licence', tone: 'warn' }
		case 'license-expired':
		case 'license-revoked':
			return { text: 'Needs a licence', tone: 'bad' }
		case 'license-grace':
			return { text: 'Licence to check', tone: 'warn' }
		case 'update-waiting':
			return { text: 'Update to review', tone: 'warn' }
		default:
			return { text: 'Off', tone: 'off' }
	}
}

/** The line under an extension's name in a row: who published it and which version. */
export const publisherLine = (row: ExtensionRow): string => `${row.publisher} · ${row.version}`

/** The line Namzu draws above every extension page: who drew it, and that Namzu never asks for secrets in it. */
export function stripWords(publisher: string): { drawnBy: string; warning: string } {
	return {
		drawnBy: `Page drawn by ${publisher}`,
		warning: 'Namzu never asks for a key or a password inside an extension page.',
	}
}

export const PAGE_STOPPED_WORDS: Record<string, string> = {
	strikes: 'This page was stopped for misusing the connection to its extension.',
	crashed: 'This page stopped working.',
	changed: 'This page was changed after it was signed, so it was stopped.',
	closed: 'This page was closed.',
}

/** What the engine's audit line means, in words a person uses. An unknown line is shown as the engine wrote it. */
const AUDIT_WORDS: Record<string, string> = {
	added: 'Added',
	'license-set': 'Licence key accepted',
	'license-expired': 'Licence expired; stopped',
	'notice-shown': 'Notice shown',
	acknowledged: 'You read the notice',
	enabled: 'Turned on',
	disabled: 'Turned off',
	started: 'Started',
	stopped: 'Stopped',
	failed: 'Could not run',
	removed: 'Removed',
	'update-staged': 'An update is waiting for you',
	'update-applied': 'Updated',
	'host-start': 'Namzu started it',
	maintenance: 'Old records cleared',
	granted: 'Optional access allowed',
	revoked: 'Optional access taken back',
	grant: 'Optional access allowed',
	revoke: 'Optional access taken back',
	'lock-set': 'An administrator password was set',
	'lock-released': 'The administrator lock was removed',
	'unlock-failed': 'A wrong or missing administrator password was refused',
	'query-refused': 'A request it made was refused',
	'message-refused': 'A message it sent was refused',
	'license-activated': 'Licence activated',
	'license-released': 'Licence released from this computer',
	'background-on': 'Starts when you sign in',
	'background-off': 'No longer starts when you sign in',
}

/** The name of the extension's own history of what it did on this computer, and the one sentence under it. */
export const EVENT_HISTORY_TITLE = 'Event history'
export const EVENT_HISTORY_SENTENCE =
	'What happened to this extension on this computer: when it was turned on, the notice was read, a licence was entered, an update was held, a password was refused or a call was refused.'

/** How many records of each kind the extension holds, from a counts answer; empty when it cannot be read. */
export function kindCounts(counts: unknown): Map<string, number> {
	const out = new Map<string, number>()
	const kinds =
		counts && typeof counts === 'object' ? (counts as { kinds?: unknown }).kinds : undefined
	if (!Array.isArray(kinds)) return out
	for (const k of kinds.slice(0, 50)) {
		if (!k || typeof k !== 'object') continue
		const { id, rows } = k as { id?: unknown; rows?: unknown }
		if (typeof id === 'string' && typeof rows === 'number' && Number.isFinite(rows) && rows >= 0)
			out.set(id, Math.floor(rows))
	}
	return out
}

/** "nothing yet", "1 record", "4 380 records": how many records there are, in words. */
export function recordCountWords(n: number | undefined): string {
	if (n === undefined) return 'Not counted yet'
	if (n === 0) return 'Nothing yet'
	return n === 1 ? '1 record' : `${n.toLocaleString('en-US').replace(/,/g, ' ')} records`
}

/** The group's title: the extension's own plain title, or the first words of what it records. */
export function kindTitle(k: { title?: string; description: string }): string {
	if (k.title) return k.title
	const first = k.description.replace(/[.!?…。]+$/, '').trim()
	return first.length > 48 ? `${first.slice(0, 45).trimEnd()}…` : first
}

export function auditWords(event: string, detail: string | undefined): string {
	const base = AUDIT_WORDS[event]
	if (!base) return detail ? `${event} ${detail}` : event
	return base
}

/** A language tag in the person's own words ("en" is English); the tag itself when the runtime has no name for it. */
export function languageName(tag: string | undefined, inLocale = 'en'): string {
	if (!tag) return 'the default language'
	try {
		return new Intl.DisplayNames([inLocale], { type: 'language' }).of(tag) ?? tag
	} catch {
		return tag
	}
}

interface ReasonContext {
	permissions?: { id: string; summary: string }[]
	dataKinds?: { id: string; description: string }[]
}

const trimStop = (t: string): string => t.replace(/[.\s]+$/, '')

/** The engine's "why you are asked again" lines without ids: what changed, in plain words. */
export function plainReason(reason: string, ctx: ReasonContext = {}): string {
	const kind = (id: string): string | undefined =>
		ctx.dataKinds?.find((k) => k.id === id)?.description
	let m = /^notice version (\S+) -> (\S+)$/.exec(reason)
	if (m) return `The notice was reworded (version ${m[1]} to ${m[2]}).`
	m = /^longer retention for (\S+): (\d+) -> (\d+)$/.exec(reason)
	if (m) {
		const what = kind(m[1] ?? '')
		return `${what ? trimStop(what) : 'Some data'} is now kept ${m[3]} days instead of ${m[2]}.`
	}
	m = /^new permission (\S+)$/.exec(reason)
	if (m) {
		const sum = ctx.permissions?.find((p) => p.id === m?.[1])?.summary
		return sum ? `It now also asks: ${trimStop(sum)}.` : 'It now also asks for something new.'
	}
	m = /^new data kind (\S+)$/.exec(reason)
	if (m) {
		const what = kind(m[1] ?? '')
		return what ? `It now also keeps: ${trimStop(what)}.` : 'It now also keeps a new kind of data.'
	}
	return reason
}

/** Every reason in plain words, each said once: five kinds kept longer read as one line when no kind is named. */
export function plainReasons(reasons: readonly string[], ctx: ReasonContext = {}): string[] {
	return [...new Set(reasons.map((r) => plainReason(r, ctx)))]
}
