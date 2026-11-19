/**
 * Extensions as the engine answers them (`namzu/extensions/*`). The types mirror the engine's
 * `ExtensionView`, `Disclosure` and `NoticeView`; the readers copy only the fields they know and clip
 * every text, so a field a newer engine adds, or a very long string, never reaches the screen. Every
 * text is plain text: nothing here is ever rendered as HTML or Markdown that carries markup.
 */

export type ExtensionState =
	| 'added'
	| 'needs-license'
	| 'needs-notice'
	| 'ready'
	| 'starting'
	| 'running'
	| 'not-responding'
	| 'stopped'
	| 'failed'
	| 'license-expired'
	| 'license-grace'
	| 'license-revoked'
	| 'update-waiting'

const STATES: readonly string[] = [
	'added',
	'needs-license',
	'needs-notice',
	'ready',
	'starting',
	'running',
	'not-responding',
	'stopped',
	'failed',
	'license-expired',
	'license-grace',
	'license-revoked',
	'update-waiting',
]

export interface ExtensionIndicator {
	level: 'ok' | 'warn' | 'stopped'
	label: string
}

/** Starts when the person signs in, and who runs it now. */
export interface ExtensionBackground {
	indicator: 'tray' | 'none'
	indicatorLabel?: string
	defaultOn: boolean
	enabled: boolean
	hostedBy: 'runner' | 'app' | 'none'
	signin?: { registered: boolean; disabledByOs?: boolean; reason?: string }
}

/** The extension's own look: its icon and accent, the pages it draws, and the chips it reported. */
export interface ExtensionUi {
	icon: string
	accent: string
	pages: {
		id: string
		title: string
		slot: 'sidebar' | 'settings' | 'panel'
		usesNetwork: boolean
		minHeight?: number
	}[]
	chips: {
		id: string
		state: string
		label: string
		tone: 'ok' | 'info' | 'warn'
		icon?: string
		opens?: string
	}[]
}

export interface ExtensionRow {
	id: string
	name: string
	version: string
	publisher: string
	state: ExtensionState
	chip: string
	indicator?: ExtensionIndicator
	dev: boolean
	needs: ('license' | 'notice')[]
	enabled: boolean
	licence?: { customer: string; seats: number; expires: string }
	licenceProblem?: string
	licenceKind: 'none' | 'key' | 'service'
	licenceHost?: string
	licenceGraceDaysLeft?: number
	licenceChecked?: { lastAt: number; lastError?: string }
	background?: ExtensionBackground
	ui?: ExtensionUi
	record?: { acknowledgedAt: string; noticeVersion: string; locale: string }
	updateWaiting?: { version: string; reasons: string[] }
	languages: string[]
	shownLocale: string
	running: boolean
	why?: string
	grants: string[]
}

export interface ExtensionDisclosure {
	extensionId: string
	name: string
	version: string
	publisher: { name: string; contact: string }
	shownLocale: string
	languageNote?: string
	permissions: {
		id: string
		level: string
		optional: boolean
		summary: string
		purposes: string[]
		prompt?: string
	}[]
	network: string
	dataFolder: string
	dataKinds: {
		id: string
		description: string
		fields: { name: string; description: string }[]
		retentionDays: number | 'keep'
	}[]
	doesNotCollect: string[]
	doesNotDo: string[]
	storage: { where: string; encryption: string; adminCanRead: boolean }
	leavesTheMachine: string
	controller: string
	licenseRequired: boolean
	/** The licence in words: not needed, a key file, or a key checked with the publisher's service. */
	licence: string
	background?: { line: string; whileClosed: string; defaultOn: boolean }
	pages?: string
	noticeVersion: string
}

export interface ExtensionNotice {
	noticeVersion: string
	scopeHash: string
	locale: string
	languageNote?: string
	text: string
	scopeWords: string[]
	disclosure: ExtensionDisclosure
	record: { acknowledgedAt: string; noticeVersion: string; noticeLocale: string } | null
	diff?: string[]
}

export interface ExtensionFailure {
	code: string
	check: string
	message: string
}

export interface ExtensionAuditLine {
	ts: string
	event: string
	detail?: string
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | undefined =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined
const str = (v: unknown, max = 600): string | undefined =>
	typeof v === 'string' ? v.slice(0, max) : undefined
const strs = (v: unknown, max = 600, count = 200): string[] =>
	Array.isArray(v)
		? v.slice(0, count).flatMap((x) => (typeof x === 'string' ? [x.slice(0, max)] : []))
		: []
const bool = (v: unknown): boolean => v === true
const num = (v: unknown): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) ? v : undefined

export function readExtensionRow(value: unknown): ExtensionRow | undefined {
	const r = rec(value)
	if (!r) return undefined
	const id = str(r.id, 120)
	const name = str(r.name, 200)
	const version = str(r.version, 40)
	const state = str(r.state, 40)
	if (!id || !name || !version || !state || !STATES.includes(state)) return undefined
	const ind = rec(r.indicator)
	const lic = rec(r.licence)
	const rcd = rec(r.record)
	const up = rec(r.updateWaiting)
	const row: ExtensionRow = {
		id,
		name,
		version,
		publisher: str(r.publisher, 120) ?? '',
		state: state as ExtensionState,
		chip: str(r.chip, 120) ?? state,
		dev: bool(r.dev),
		needs: strs(r.needs, 20, 4).filter(
			(n): n is 'license' | 'notice' => n === 'license' || n === 'notice',
		),
		enabled: bool(r.enabled),
		licenceKind: r.licenceKind === 'service' || r.licenceKind === 'key' ? r.licenceKind : 'none',
		languages: strs(r.languages, 35, 40),
		shownLocale: str(r.shownLocale, 35) ?? '',
		running: bool(r.running),
		grants: strs(r.grants, 64, 24),
	}
	if (
		ind &&
		(ind.level === 'ok' || ind.level === 'warn' || ind.level === 'stopped') &&
		str(ind.label, 300)
	)
		row.indicator = { level: ind.level, label: str(ind.label, 300) as string }
	if (lic && str(lic.customer, 120) && num(lic.seats) !== undefined && str(lic.expires, 40))
		row.licence = {
			customer: str(lic.customer, 120) as string,
			seats: num(lic.seats) as number,
			expires: str(lic.expires, 40) as string,
		}
	const lp = str(r.licenceProblem, 300)
	if (lp) row.licenceProblem = lp
	if (rcd && str(rcd.acknowledgedAt, 40) && str(rcd.noticeVersion, 20))
		row.record = {
			acknowledgedAt: str(rcd.acknowledgedAt, 40) as string,
			noticeVersion: str(rcd.noticeVersion, 20) as string,
			locale: str(rcd.locale, 35) ?? '',
		}
	if (up && str(up.version, 40))
		row.updateWaiting = {
			version: str(up.version, 40) as string,
			reasons: strs(up.reasons, 300, 50),
		}
	const host = str(r.licenceHost, 253)
	if (host) row.licenceHost = host
	const grace = num(r.licenceGraceDaysLeft)
	if (grace !== undefined) row.licenceGraceDaysLeft = grace
	const chk = rec(r.licenceChecked)
	if (chk && num(chk.lastAt) !== undefined)
		row.licenceChecked = {
			lastAt: num(chk.lastAt) as number,
			...(str(chk.lastError, 60) ? { lastError: str(chk.lastError, 60) as string } : {}),
		}
	const bg = rec(r.background)
	if (bg && (bg.indicator === 'tray' || bg.indicator === 'none')) {
		const si = rec(bg.signin)
		row.background = {
			indicator: bg.indicator,
			...(str(bg.indicatorLabel, 300)
				? { indicatorLabel: str(bg.indicatorLabel, 300) as string }
				: {}),
			defaultOn: bool(bg.defaultOn),
			enabled: bool(bg.enabled),
			hostedBy: bg.hostedBy === 'runner' || bg.hostedBy === 'app' ? bg.hostedBy : 'none',
			...(si
				? {
						signin: {
							registered: bool(si.registered),
							...(si.disabledByOs === true ? { disabledByOs: true } : {}),
							...(str(si.reason, 200) ? { reason: str(si.reason, 200) as string } : {}),
						},
					}
				: {}),
		}
	}
	const ui = readUi(r.ui)
	if (ui) row.ui = ui
	const why = str(r.why, 300)
	if (why) row.why = why
	return row
}

const SLOTS = ['sidebar', 'settings', 'panel'] as const
const TONES = ['ok', 'info', 'warn'] as const

function readUi(value: unknown): ExtensionUi | undefined {
	const u = rec(value)
	if (!u || !str(u.icon, 200) || !/^#[0-9a-fA-F]{6}$/.test(str(u.accent, 9) ?? '')) return undefined
	const pages: ExtensionUi['pages'] = []
	for (const p of Array.isArray(u.pages) ? u.pages.slice(0, 6) : []) {
		const q = rec(p)
		const slot = (SLOTS as readonly unknown[]).find((x) => x === q?.slot)
		if (q && str(q.id, 48) && slot)
			pages.push({
				id: str(q.id, 48) as string,
				title: str(q.title, 200) ?? (str(q.id, 48) as string),
				slot: slot as 'sidebar' | 'settings' | 'panel',
				usesNetwork: bool(q.usesNetwork),
				...(num(q.minHeight) !== undefined ? { minHeight: num(q.minHeight) as number } : {}),
			})
	}
	const chips: ExtensionUi['chips'] = []
	for (const c of Array.isArray(u.chips) ? u.chips.slice(0, 2) : []) {
		const q = rec(c)
		const tone = (TONES as readonly unknown[]).find((x) => x === q?.tone)
		if (q && str(q.id, 48) && str(q.state, 24) && str(q.label, 80) && tone)
			chips.push({
				id: str(q.id, 48) as string,
				state: str(q.state, 24) as string,
				label: str(q.label, 80) as string,
				tone: tone as 'ok' | 'info' | 'warn',
				...(str(q.icon, 200) ? { icon: str(q.icon, 200) as string } : {}),
				...(str(q.opens, 48) ? { opens: str(q.opens, 48) as string } : {}),
			})
	}
	return { icon: str(u.icon, 200) as string, accent: str(u.accent, 9) as string, pages, chips }
}

export function readExtensionList(value: unknown): ExtensionRow[] | undefined {
	const r = rec(value)
	if (!r || !Array.isArray(r.extensions)) return undefined
	return r.extensions.slice(0, 100).flatMap((x) => {
		const row = readExtensionRow(x)
		return row ? [row] : []
	})
}

export function readDisclosure(value: unknown): ExtensionDisclosure | undefined {
	const r = rec(value)
	const pub = rec(r?.publisher)
	const stor = rec(r?.storage)
	if (!r || !pub || !stor || !str(r.extensionId, 120) || !Array.isArray(r.permissions))
		return undefined
	const out: ExtensionDisclosure = {
		extensionId: str(r.extensionId, 120) as string,
		name: str(r.name, 200) ?? '',
		version: str(r.version, 40) ?? '',
		publisher: { name: str(pub.name, 120) ?? '', contact: str(pub.contact, 120) ?? '' },
		shownLocale: str(r.shownLocale, 35) ?? '',
		permissions: r.permissions.slice(0, 24).flatMap((p) => {
			const q = rec(p)
			if (!q || !str(q.id, 64)) return []
			return [
				{
					id: str(q.id, 64) as string,
					level: str(q.level, 10) ?? 'low',
					optional: bool(q.optional),
					summary: str(q.summary, 900) ?? '',
					purposes: strs(q.purposes, 900, 12),
					...(str(q.prompt, 900) ? { prompt: str(q.prompt, 900) as string } : {}),
				},
			]
		}),
		network: str(r.network, 200) ?? '',
		dataFolder: str(r.dataFolder, 1000) ?? '',
		dataKinds: (Array.isArray(r.dataKinds) ? r.dataKinds : []).slice(0, 24).flatMap((k) => {
			const q = rec(k)
			if (!q || !str(q.id, 64)) return []
			return [
				{
					id: str(q.id, 64) as string,
					description: str(q.description, 900) ?? '',
					fields: (Array.isArray(q.fields) ? q.fields : []).slice(0, 24).flatMap((f) => {
						const g = rec(f)
						return g && str(g.name, 40)
							? [{ name: str(g.name, 40) as string, description: str(g.description, 300) ?? '' }]
							: []
					}),
					retentionDays: q.retentionDays === 'keep' ? 'keep' : (num(q.retentionDays) ?? 0),
				},
			]
		}),
		doesNotCollect: strs(r.doesNotCollect, 300, 30),
		doesNotDo: strs(r.doesNotDo, 300, 20),
		storage: {
			where: str(stor.where, 300) ?? '',
			encryption: str(stor.encryption, 300) ?? '',
			adminCanRead: bool(stor.adminCanRead),
		},
		leavesTheMachine: str(r.leavesTheMachine, 200) ?? '',
		controller: str(r.controller, 300) ?? '',
		licenseRequired: bool(r.licenseRequired),
		licence: str(r.licence, 600) ?? '',
		noticeVersion: str(r.noticeVersion, 20) ?? '',
	}
	const bgd = rec(r.background)
	if (bgd && str(bgd.line, 300) && str(bgd.whileClosed, 400))
		out.background = {
			line: str(bgd.line, 300) as string,
			whileClosed: str(bgd.whileClosed, 400) as string,
			defaultOn: bool(bgd.defaultOn),
		}
	const pg = str(r.pages, 600)
	if (pg) out.pages = pg
	const note = str(r.languageNote, 300)
	if (note) out.languageNote = note
	return out
}

export function readNotice(value: unknown): ExtensionNotice | undefined {
	const r = rec(value)
	const d = readDisclosure(r?.disclosure)
	if (!r || !d || !str(r.noticeVersion, 20) || !str(r.scopeHash, 64)) return undefined
	const rcd = rec(r.record)
	const out: ExtensionNotice = {
		noticeVersion: str(r.noticeVersion, 20) as string,
		scopeHash: str(r.scopeHash, 64) as string,
		locale: str(r.locale, 35) ?? '',
		text: str(r.text, 200_000) ?? '',
		scopeWords: strs(r.scopeWords, 900, 100),
		disclosure: d,
		record:
			rcd && str(rcd.acknowledgedAt, 40)
				? {
						acknowledgedAt: str(rcd.acknowledgedAt, 40) as string,
						noticeVersion: str(rcd.noticeVersion, 20) ?? '',
						noticeLocale: str(rcd.noticeLocale, 35) ?? '',
					}
				: null,
	}
	const note = str(r.languageNote, 300)
	if (note) out.languageNote = note
	if (Array.isArray(r.diff)) out.diff = strs(r.diff, 300, 50)
	return out
}

/** `{ error: { code, check, message } }`: a refusal the person can read, answered rather than thrown. */
export function readFailure(value: unknown): ExtensionFailure | undefined {
	const e = rec(rec(value)?.error)
	if (!e || !str(e.code, 60)) return undefined
	return {
		code: str(e.code, 60) as string,
		check: str(e.check, 60) ?? '',
		message: str(e.message, 600) ?? '',
	}
}

export function readAudit(value: unknown): ExtensionAuditLine[] {
	const r = rec(value)
	if (!r || !Array.isArray(r.lines)) return []
	return r.lines.slice(0, 500).flatMap((l) => {
		const q = rec(l)
		return q && str(q.ts, 40) && str(q.event, 40)
			? [
					{
						ts: str(q.ts, 40) as string,
						event: str(q.event, 40) as string,
						...(str(q.detail, 300) ? { detail: str(q.detail, 300) as string } : {}),
					},
				]
			: []
	})
}

/** The methods the page may call through the one bridge; anything else is refused in the main process. */
export const EXTENSION_BRIDGE_METHODS: readonly string[] = [
	'namzu/extensions/list',
	'namzu/extensions/license',
	'namzu/extensions/notice',
	'namzu/extensions/acknowledge',
	'namzu/extensions/enable',
	'namzu/extensions/disable',
	'namzu/extensions/remove',
	'namzu/extensions/grant',
	'namzu/extensions/revoke',
	'namzu/extensions/query',
	'namzu/extensions/settings/get',
	'namzu/extensions/settings/set',
	'namzu/extensions/audit',
	'namzu/extensions/background/get',
	'namzu/extensions/background/set',
	'namzu/extensions/runner',
]

export interface ExtensionStateEvent {
	id: string
	state: ExtensionState
	indicator?: ExtensionIndicator
	since: number
}

export function readStateEvent(value: unknown): ExtensionStateEvent | undefined {
	const r = rec(value)
	const id = str(r?.id, 120)
	const state = str(r?.state, 40)
	if (!r || !id || !state || !STATES.includes(state)) return undefined
	const ind = rec(r.indicator)
	return {
		id,
		state: state as ExtensionState,
		since: num(r.since) ?? 0,
		...(ind &&
		(ind.level === 'ok' || ind.level === 'warn' || ind.level === 'stopped') &&
		str(ind.label, 300)
			? { indicator: { level: ind.level, label: str(ind.label, 300) as string } }
			: {}),
	}
}
