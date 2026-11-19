import type { ProviderLimits } from '@namzu/sdk'
import type { LimitsKind, LimitsSource } from '../integrations/limits/sources.js'

/**
 * The desktop's view of what each provider in use says about the account behind it: usage windows,
 * credit, or an estimate of spend. A host-level notification, not a session one, and a request that
 * reads it again. Account data: it is held in memory, never logged with its values, never stored
 * and never put into a prompt. A field that is absent means "not reported", never zero.
 *
 * The desktop half is `packages/desktop/src/shared/limits-protocol.ts`.
 */
export const LIMITS_NOTIFICATION = 'namzu/limits'
export const LIMITS_REFRESH_METHOD = 'namzu/limits/refresh'

/** A provider that has to be asked is asked at most this often. */
export const LIMITS_MIN_REFRESH_MS = 60_000

/** Providers whose limits ride on responses already made: reading them costs no request. */
export const PASSIVE_PROVIDERS: ReadonlySet<string> = new Set(['anthropic'])

export interface LimitsWindowNotice {
	readonly label: string
	/** 0 to 1, as the vendor gave it. */
	readonly usedFraction: number
	/** Milliseconds since the epoch. */
	readonly resetsAt?: number
	readonly rejected?: boolean
}

export interface LimitsProviderNotice {
	readonly provider: string
	readonly label: string
	readonly kind: LimitsKind
	readonly plan?: string
	readonly windows?: readonly LimitsWindowNotice[]
	readonly credit?: {
		readonly currency: string
		readonly used?: number
		readonly limit?: number
		readonly remaining?: number
	}
	/** An estimate at list prices from the local record, for a key the vendor reports nothing about. */
	readonly spend?: { readonly usd: number; readonly days: number; readonly partial: boolean }
	readonly asOf?: number
}

export interface LimitsNotification {
	readonly providers: readonly LimitsProviderNotice[]
}

export interface LimitsFeedSource extends LimitsSource {
	readonly providers: readonly {
		readLimits?: (signal?: AbortSignal) => Promise<ProviderLimits | undefined>
	}[]
}

export interface LimitsFeedOptions {
	readonly sources: () => readonly LimitsFeedSource[]
	/** Estimated spend at list prices over the last `days`, for a provider id; undefined when unknown. */
	readonly spend?: (
		provider: string,
	) => Promise<{ usd: number; days: number; partial: boolean } | undefined>
	readonly notify: (method: string, params: Record<string, unknown>) => void
	/** Milliseconds on a clock; injected so tests never wait. */
	readonly now: () => number
	readonly minRefreshMs?: number
	/** Provider ids whose limits cost no request to read; defaults to {@link PASSIVE_PROVIDERS}. */
	readonly passive?: ReadonlySet<string>
}

export interface LimitsFeed {
	/** Reads again (a provider that must be asked only once a minute) and returns what is known. */
	refresh(): Promise<LimitsNotification>
	/** After a turn: the readings that cost no request are re-read, and said if they changed. */
	noteTurnEnd(): Promise<void>
}

const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value)

/** What of a vendor reading is allowed on the wire: known fields only, fractions clamped. */
export function noticeFromLimits(limits: ProviderLimits): Partial<LimitsProviderNotice> {
	const windows = (limits.windows ?? []).flatMap((window): LimitsWindowNotice[] =>
		window && typeof window.label === 'string' && finite(window.usedFraction)
			? [
					{
						label: window.label.slice(0, 80),
						usedFraction: Math.min(1, Math.max(0, window.usedFraction)),
						...(finite(window.resetsAt) ? { resetsAt: window.resetsAt } : {}),
						...(window.rejected === true ? { rejected: true } : {}),
					},
				]
			: [],
	)
	const credit = limits.credit
	const checkedCredit =
		credit && typeof credit.currency === 'string' && credit.currency !== ''
			? {
					currency: credit.currency.slice(0, 16),
					...(finite(credit.used) ? { used: credit.used } : {}),
					...(finite(credit.limit) ? { limit: credit.limit } : {}),
					...(finite(credit.remaining) ? { remaining: credit.remaining } : {}),
				}
			: undefined
	return {
		...(windows.length > 0 ? { windows } : {}),
		...(checkedCredit ? { credit: checkedCredit } : {}),
		...(typeof limits.plan === 'string' && limits.plan !== ''
			? { plan: limits.plan.slice(0, 40) }
			: {}),
		...(finite(limits.asOf) ? { asOf: limits.asOf } : {}),
	}
}

export function createLimitsFeed(options: LimitsFeedOptions): LimitsFeed {
	const minimum = options.minRefreshMs ?? LIMITS_MIN_REFRESH_MS
	const PASSIVE = options.passive ?? PASSIVE_PROVIDERS
	/** The last reading per provider id, and when a request for it was last made. */
	const readings = new Map<string, { notice: Partial<LimitsProviderNotice>; askedAt: number }>()
	let lastSent = ''

	const readOne = async (source: LimitsFeedSource, force: boolean): Promise<void> => {
		const passive = PASSIVE.has(source.id)
		const known = readings.get(source.id)
		if (!passive && known && !force && options.now() - known.askedAt < minimum) return
		let newest: ProviderLimits | undefined
		for (const provider of source.providers) {
			if (!provider.readLimits) continue
			try {
				const seen = await provider.readLimits()
				if (seen && (!newest || seen.asOf > newest.asOf)) newest = seen
			} catch {
				/* A failed read keeps the last one; the feed is a convenience. */
			}
		}
		// A request is counted even when it learned nothing, so a refusing vendor is not asked every second.
		readings.set(source.id, {
			notice: newest ? noticeFromLimits(newest) : (known?.notice ?? {}),
			askedAt: passive ? (known?.askedAt ?? 0) : options.now(),
		})
	}

	const build = async (): Promise<LimitsNotification> => {
		const providers: LimitsProviderNotice[] = []
		for (const source of options.sources()) {
			const notice = readings.get(source.id)?.notice ?? {}
			let spend: LimitsProviderNotice['spend']
			if (source.kind === 'key' && !notice.credit && !notice.windows && options.spend) {
				try {
					spend = await options.spend(source.id)
				} catch {
					spend = undefined
				}
			}
			providers.push({
				provider: source.id,
				label: source.label,
				kind: source.kind,
				...notice,
				...(spend && spend.usd > 0 ? { spend } : {}),
			})
		}
		return { providers }
	}

	return {
		async refresh() {
			const sources = options.sources()
			await Promise.all(sources.map((source) => readOne(source, false)))
			const view = await build()
			lastSent = JSON.stringify(view)
			return view
		},
		async noteTurnEnd() {
			const sources = options.sources().filter((source) => PASSIVE.has(source.id))
			if (sources.length === 0) return
			await Promise.all(sources.map((source) => readOne(source, false)))
			const view = await build()
			const text = JSON.stringify(view)
			if (text === lastSent) return
			lastSent = text
			try {
				options.notify(LIMITS_NOTIFICATION, { ...view })
			} catch {
				/* A closed stream must not fail the turn. */
			}
		},
	}
}
