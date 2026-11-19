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

/** How long, in the words the record uses: "5 h 20 min", "28 min", "0 min". */
export function durationWords(minutes: number): string {
	const m = Math.max(0, Math.round(minutes))
	const h = Math.floor(m / 60)
	return h > 0 ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`
}

/** A minute of the day as a clock: 527 is "08:47". */
export function clockWords(minuteOfDay: number): string {
	const m = Math.max(0, Math.min(24 * 60, Math.round(minuteOfDay)))
	return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export type DayState = 'at' | 'idle' | 'away'

/** One stretch of the day in one state, in minutes since midnight. */
export interface DayPart {
	from: number
	to: number
	state: DayState
}

export interface DaySummary {
	atMinutes: number
	idleMinutes: number
	awayMinutes: number
	/** The first and last minute recorded today; undefined when the answer carries no times. */
	firstMinute?: number
	lastMinute?: number
	parts: DayPart[]
}

/** The id of the per-minute state kind in a counts answer, whichever extension names it. */
export function stateKindOf(counts: unknown): string | undefined {
	if (!counts || typeof counts !== 'object') return undefined
	const kinds = (counts as { kinds?: unknown }).kinds
	if (!Array.isArray(kinds)) return undefined
	for (const k of kinds) {
		const id = k && typeof k === 'object' ? (k as { id?: unknown }).id : undefined
		if (typeof id === 'string' && /state/i.test(id) && /minute/i.test(id)) return id
	}
	return undefined
}

/** The person's own day as two UTC instants: local midnight and the next local midnight. */
export function dayRange(now: Date): { from: string; to: string } {
	const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z')
	return {
		from: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate())),
		to: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)),
	}
}

/**
 * Every row of one kind for today, page after page until the extension says there is no next page.
 * The extension's defaults (oldest first, a hundred a page, a week kept) would show earlier days, so the
 * day is asked for by its bounds. `ask` gives one page's answer, or undefined when it could not be read.
 */
export async function readDayRows(
	kind: string,
	now: Date,
	ask: (params: Record<string, unknown>) => Promise<unknown>,
): Promise<{ columns: unknown; rows: unknown[] } | undefined> {
	const range = dayRange(now)
	let columns: unknown
	const rows: unknown[] = []
	let after: string | undefined
	// A day is at most 1440 minute rows; the bound only stops an extension that never ends its pages.
	for (let page = 0; page < 40; page++) {
		const a = (await ask({ kind, ...range, limit: 500, ...(after ? { after } : {}) })) as
			| { columns?: unknown; rows?: unknown; next?: unknown }
			| undefined
		if (!a || typeof a !== 'object' || !Array.isArray(a.rows))
			return page === 0 ? undefined : { columns, rows }
		columns ??= a.columns
		rows.push(...a.rows)
		if (typeof a.next !== 'string' || a.next === '') break
		after = a.next
	}
	return { columns, rows }
}

const TIME_COLUMNS = ['ts', 'time', 'minute', 'at', 'startedat', 'start', 't']

function minuteOfToday(value: unknown, today: Date): number | undefined {
	let ms: number | undefined
	if (typeof value === 'number' && Number.isFinite(value)) ms = value < 1e11 ? value * 1000 : value
	else if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value)
		ms = Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(value)
	}
	if (ms === undefined || Number.isNaN(ms)) return undefined
	const d = new Date(ms)
	if (
		d.getFullYear() !== today.getFullYear() ||
		d.getMonth() !== today.getMonth() ||
		d.getDate() !== today.getDate()
	)
		return -1
	return d.getHours() * 60 + d.getMinutes()
}

/**
 * Today's totals and parts from the rows of a per-minute state kind (seconds active, idle, locked and
 * asleep for each minute). Only what is understood is used: a column that is missing means no times and
 * no ribbon, and an answer with none of the four columns means no summary, so the caller draws nothing
 * it cannot stand behind. `today` is passed in so the day is the person's own, and tests are fixed.
 */
export function daySummary(answer: unknown, today: Date): DaySummary | undefined {
	if (!answer || typeof answer !== 'object') return undefined
	const r = answer as { columns?: unknown; rows?: unknown }
	if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) return undefined
	const cols = r.columns.map((c) => (typeof c === 'string' ? c.toLowerCase() : ''))
	const find = (re: RegExp) => cols.findIndex((c) => re.test(c))
	const active = find(/^active/)
	const idle = find(/^idle/)
	const locked = find(/^locked/)
	const asleep = find(/^asleep/)
	if (active < 0 && idle < 0 && locked < 0 && asleep < 0) return undefined
	let timeAt = -1
	for (const name of TIME_COLUMNS) {
		timeAt = cols.indexOf(name)
		if (timeAt >= 0) break
	}
	const num = (row: unknown[], at: number): number => {
		const v = at >= 0 ? Number(row[at]) : 0
		return Number.isFinite(v) && v > 0 ? v : 0
	}
	let at = 0
	let idleS = 0
	let away = 0
	const minutes: { minute: number; state: DayState }[] = []
	for (const raw of r.rows.slice(0, 2000)) {
		if (!Array.isArray(raw)) continue
		let minute: number | undefined
		if (timeAt >= 0) {
			minute = minuteOfToday(raw[timeAt], today)
			if (minute === undefined || minute < 0) continue
		}
		const a = num(raw, active)
		const i = num(raw, idle)
		const w = num(raw, locked) + num(raw, asleep)
		at += a
		idleS += i
		away += w
		if (minute !== undefined)
			minutes.push({ minute, state: a >= i && a >= w ? 'at' : i >= w ? 'idle' : 'away' })
	}
	minutes.sort((x, y) => x.minute - y.minute)
	const parts: DayPart[] = []
	for (const m of minutes) {
		const last = parts[parts.length - 1]
		if (last && last.state === m.state && m.minute <= last.to) last.to = m.minute + 1
		else parts.push({ from: m.minute, to: m.minute + 1, state: m.state })
	}
	const first = minutes[0]
	const end = minutes[minutes.length - 1]
	return {
		atMinutes: Math.round(at / 60),
		idleMinutes: Math.round(idleS / 60),
		awayMinutes: Math.round(away / 60),
		...(first && end ? { firstMinute: first.minute, lastMinute: end.minute + 1 } : {}),
		parts,
	}
}

export interface Ribbon {
	segments: { state: DayState | 'gap'; left: number; width: number }[]
	ticks: { label: string; left: number }[]
	/** Where the moment now sits, in percent of the ribbon. */
	now: number
}

/**
 * The day as a ribbon: whole hours around what was recorded (at least six hours wide), a tick every
 * second hour when it is narrow and every third when it is wide, and the gaps left empty.
 */
export function ribbonLayout(parts: readonly DayPart[], nowMinute: number): Ribbon | undefined {
	if (parts.length === 0) return undefined
	const first = Math.min(...parts.map((p) => p.from))
	const last = Math.max(nowMinute, ...parts.map((p) => p.to))
	let start = Math.floor(first / 60) * 60
	let end = Math.ceil(last / 60) * 60
	if (end - start < 360) {
		end = Math.min(24 * 60, start + 360)
		start = Math.max(0, end - 360)
	}
	const span = end - start
	const pct = (m: number) => ((m - start) / span) * 100
	const segments: Ribbon['segments'] = []
	let at = start
	for (const p of parts) {
		if (p.from > at) segments.push({ state: 'gap', left: pct(at), width: pct(p.from) - pct(at) })
		segments.push({ state: p.state, left: pct(p.from), width: pct(p.to) - pct(p.from) })
		at = p.to
	}
	const step = span > 600 ? 180 : 120
	const ticks: Ribbon['ticks'] = []
	for (let m = Math.ceil(start / step) * step; m <= end; m += step)
		ticks.push({ label: clockWords(m), left: pct(m) })
	return { segments, ticks, now: Math.max(0, Math.min(100, pct(nowMinute))) }
}
