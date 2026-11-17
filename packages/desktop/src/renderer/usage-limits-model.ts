import type {
	LimitsNotification,
	LimitsProviderNotice,
	LimitsWindowNotice,
} from '../shared/limits-protocol.js'

/** A window reads "getting close" from here, and "critical" from the next. A rejected window reads full. */
export const LIMIT_WARN = 0.75
export const LIMIT_CRITICAL = 0.9

/** A header-sourced reading older than this says how old it is. */
export const STALE_AFTER_MS = 5 * 60 * 1000
/** How often a vendor that has to be asked may be asked. */
export const LIMITS_REFRESH_MS = 60 * 1000

export type LimitTone = 'normal' | 'high' | 'full'

export function limitTone(fraction: number, rejected = false): LimitTone {
	if (rejected || fraction >= LIMIT_CRITICAL) return 'full'
	return fraction >= LIMIT_WARN ? 'high' : 'normal'
}

const TONE_ORDER: Record<LimitTone, number> = { normal: 0, high: 1, full: 2 }
export const worseTone = (a: LimitTone, b: LimitTone): LimitTone =>
	TONE_ORDER[a] >= TONE_ORDER[b] ? a : b

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When a window resets, in the person's own clock: "Resets at 3:00 PM" within a day, and "Resets Sat
 * 2:00 PM" beyond it. `timeZone` is for tests; the viewer's own zone is the default.
 */
export function resetText(resetsAt: number, now: number, timeZone?: string): string {
	const zone = timeZone ? { timeZone } : {}
	const time = new Intl.DateTimeFormat('en-US', {
		hour: 'numeric',
		minute: '2-digit',
		...zone,
	}).format(resetsAt)
	if (resetsAt - now <= DAY_MS) return `Resets at ${time}`
	const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', ...zone }).format(resetsAt)
	return `Resets ${day} ${time}`
}

/** "as of 12 min ago", only for a reading older than {@link STALE_AFTER_MS}. */
export function asOfText(asOf: number | undefined, now: number): string | undefined {
	if (asOf === undefined || now - asOf <= STALE_AFTER_MS) return undefined
	const minutes = Math.floor((now - asOf) / 60000)
	if (minutes < 60) return `as of ${minutes} min ago`
	const hours = Math.floor(minutes / 60)
	return `as of ${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
}

export interface WindowRow {
	shape: 'window'
	key: string
	label: string
	/** "27%"; absent when the window has reset since the reading, so no number is stood behind. */
	percent?: string
	fraction: number
	reset?: string
	tone: LimitTone
	/** "Getting close", "Limit reached"; absent when all is well. */
	state?: string
	/** The reading is older than the window itself. */
	stale: boolean
	asOf?: string
}
export interface SpendRow {
	shape: 'spend'
	key: string
	text: string
	/** With a budget, how much of it is used. */
	fraction?: number
	tone: LimitTone
	/** The provider the budget would be set for. */
	provider: string
	budgetUsd?: number
}
export interface CreditRow {
	shape: 'credit'
	key: string
	text: string
	fraction?: number
	tone: LimitTone
}
export interface NoneRow {
	shape: 'none'
	key: string
	text: string
}
export type LimitRow = WindowRow | SpendRow | CreditRow | NoneRow

export interface LimitSection {
	provider: string
	title: string
	rows: LimitRow[]
}

export interface UsageLimitsModel {
	sections: LimitSection[]
	/** The worst tone of anything measured: what the indicator ring turns. */
	tone: LimitTone
	/** The most-used measured fraction, or undefined when nothing is measured. */
	worst?: number
	/** One quiet line under the composer when something is critical, else undefined. */
	critical?: string
}

const usd = (value: number) => `$${value.toFixed(2)}`
function money(currency: string, value: number): string {
	if (currency === 'USD') return usd(value)
	if (currency === 'credits') return `${Number(value.toFixed(2))} credits`
	return `${value.toFixed(2)} ${currency}`
}

function windowRow(
	provider: string,
	window: LimitsWindowNotice,
	asOf: number | undefined,
	now: number,
	timeZone?: string,
): WindowRow {
	const reset = window.resetsAt
	const stale = reset !== undefined && reset <= now && !window.rejected
	const tone = stale ? 'normal' : limitTone(window.usedFraction, window.rejected)
	const fraction = window.rejected ? 1 : window.usedFraction
	const age = asOfText(asOf, now)
	return {
		shape: 'window',
		key: `${provider}:${window.label}`,
		label: window.label,
		...(stale ? {} : { percent: `${Math.round(fraction * 100)}%` }),
		fraction: stale ? 0 : fraction,
		...(reset !== undefined && !stale ? { reset: resetText(reset, now, timeZone) } : {}),
		tone,
		...(stale
			? { state: 'Reset since the last reply' }
			: window.rejected
				? { state: 'Limit reached' }
				: tone !== 'normal'
					? { state: 'Getting close' }
					: {}),
		stale,
		...(age ? { asOf: age } : {}),
	}
}

function rowsFor(
	notice: LimitsProviderNotice,
	now: number,
	budgets: Readonly<Record<string, number>>,
	timeZone?: string,
): LimitRow[] {
	const rows: LimitRow[] = []
	for (const window of notice.windows ?? [])
		rows.push(windowRow(notice.provider, window, notice.asOf, now, timeZone))
	const credit = notice.credit
	if (credit) {
		const { currency, used, limit, remaining } = credit
		if (limit !== undefined && used !== undefined && limit > 0) {
			const fraction = Math.min(1, used / limit)
			rows.push({
				shape: 'credit',
				key: `${notice.provider}:credit`,
				text: `Credit used ${money(currency, used)} of ${money(currency, limit)}`,
				fraction,
				tone: limitTone(fraction),
			})
		} else if (remaining !== undefined) {
			rows.push({
				shape: 'credit',
				key: `${notice.provider}:credit`,
				text: `Balance ${money(currency, remaining)}`,
				tone: 'normal',
			})
		} else if (used !== undefined) {
			rows.push({
				shape: 'credit',
				key: `${notice.provider}:credit`,
				text: `Used ${money(currency, used)}`,
				tone: 'normal',
			})
		}
	}
	if (notice.spend) {
		const { usd: spent, days, partial } = notice.spend
		const budget = budgets[notice.provider]
		const about = `${partial ? 'at least ' : 'about '}${usd(spent)}`
		const span = `in the last ${days} days (list prices)`
		rows.push(
			budget !== undefined && budget > 0
				? {
						shape: 'spend',
						key: `${notice.provider}:spend`,
						provider: notice.provider,
						budgetUsd: budget,
						text: `Spent ${about} of ${usd(budget)} budget ${span}`,
						fraction: Math.min(1, spent / budget),
						tone: limitTone(spent / budget),
					}
				: {
						shape: 'spend',
						key: `${notice.provider}:spend`,
						provider: notice.provider,
						text: `Spent ${about} ${span}`,
						tone: 'normal',
					},
		)
	}
	if (rows.length === 0)
		rows.push({
			shape: 'none',
			key: `${notice.provider}:none`,
			text: `${notice.label}: usage limits are not reported for this sign-in.`,
		})
	return rows
}

export interface UsageLimitsInput {
	view: LimitsNotification | undefined
	/** The conversation's own provider is listed first. */
	currentProvider?: string | undefined
	now: number
	/** Optional budgets in US dollars the person set, by provider. */
	budgets?: Readonly<Record<string, number>>
	timeZone?: string
}

/** Everything the popover and the indicator say, from one reading. Pure; nothing is requested. */
export function usageLimitsModel(input: UsageLimitsInput): UsageLimitsModel {
	const providers = [...(input.view?.providers ?? [])].sort(
		(a, b) =>
			Number(b.provider === input.currentProvider) - Number(a.provider === input.currentProvider),
	)
	const budgets = input.budgets ?? {}
	let tone: LimitTone = 'normal'
	let worst: number | undefined
	let critical: string | undefined
	const sections = providers.map((notice): LimitSection => {
		const rows = rowsFor(notice, input.now, budgets, input.timeZone)
		for (const row of rows) {
			if (row.shape === 'none') continue
			if (row.shape === 'window' && row.stale) continue
			tone = worseTone(tone, row.tone)
			if (row.fraction !== undefined) worst = Math.max(worst ?? 0, row.fraction)
			if (row.shape === 'window' && row.tone === 'full' && !critical)
				critical = `${row.label} is at ${row.percent ?? '100%'}${row.reset ? `, ${row.reset.charAt(0).toLowerCase()}${row.reset.slice(1)}` : ''}`
		}
		return {
			provider: notice.provider,
			title: notice.plan ? `${notice.label} · ${notice.plan}` : notice.label,
			rows,
		}
	})
	return {
		sections,
		tone,
		...(worst === undefined ? {} : { worst }),
		...(critical ? { critical } : {}),
	}
}

/** The reader of the last answer, so the vendor is asked at most once in `minMs`. */
export function createLimitsRefresher<T>(options: {
	request: () => Promise<T>
	now: () => number
	minMs?: number
}): { refresh(): Promise<T> | undefined } {
	const minimum = options.minMs ?? LIMITS_REFRESH_MS
	let last: number | undefined
	return {
		refresh() {
			const now = options.now()
			if (last !== undefined && now - last < minimum) return undefined
			last = now
			return options.request()
		},
	}
}

const BUDGET_KEY = 'namzu.limit-budgets'

/** Budgets the person set, by provider, in US dollars. Kept in this browser only; never sent anywhere. */
export function readBudgets(storage: Pick<Storage, 'getItem'> | undefined): Record<string, number> {
	try {
		const raw = storage?.getItem(BUDGET_KEY)
		if (!raw) return {}
		const parsed: unknown = JSON.parse(raw)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		const out: Record<string, number> = {}
		for (const [provider, value] of Object.entries(parsed))
			if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e9)
				out[provider] = value
		return out
	} catch {
		return {}
	}
}

export function writeBudgets(
	storage: Pick<Storage, 'setItem'> | undefined,
	budgets: Readonly<Record<string, number>>,
): void {
	try {
		storage?.setItem(BUDGET_KEY, JSON.stringify(budgets))
	} catch {
		// A blocked store only means the budget is not remembered.
	}
}
