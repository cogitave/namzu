/**
 * What the Namzu host says about the account behind each provider in use, read before anything
 * trusts it. The desktop half of `packages/cli/src/commands/desktop-limits-feed.ts`: the
 * notification is `namzu/limits`, the request that reads it again is `namzu/limits/refresh`.
 *
 * Account data. It is kept in memory only and never written to a log, a file, a prompt or
 * telemetry. A field that is absent means "not reported", and nothing here turns it into a zero.
 */
export const LIMITS_NOTIFICATION = 'namzu/limits'
export const LIMITS_REFRESH_METHOD = 'namzu/limits/refresh'

/** How the credential behind a provider was obtained. */
export type LimitsKind = 'sign-in' | 'key' | 'local'

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

const MAX_PROVIDERS = 12
const MAX_WINDOWS = 4
const MAX_AMOUNT = 1e12
const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object' && !Array.isArray(value)

function amount(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT
		? value
		: undefined
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g

function text(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined
	const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
	return clean === '' ? undefined : clean.slice(0, max)
}

function readWindow(value: unknown): LimitsWindowNotice | undefined {
	if (!isRecord(value)) return undefined
	const label = text(value.label, 80)
	const used = value.usedFraction
	if (label === undefined || typeof used !== 'number' || !Number.isFinite(used)) return undefined
	const resetsAt = amount(value.resetsAt)
	return {
		label,
		usedFraction: Math.min(1, Math.max(0, used)),
		...(resetsAt === undefined ? {} : { resetsAt }),
		...(value.rejected === true ? { rejected: true } : {}),
	}
}

function readProvider(value: unknown): LimitsProviderNotice | undefined {
	if (!isRecord(value)) return undefined
	const provider = text(value.provider, 40)
	const label = text(value.label, 60)
	const kind = value.kind
	if (provider === undefined || label === undefined) return undefined
	if (kind !== 'sign-in' && kind !== 'key' && kind !== 'local') return undefined
	const windows = Array.isArray(value.windows)
		? value.windows
				.slice(0, MAX_WINDOWS)
				.map(readWindow)
				.filter((window): window is LimitsWindowNotice => window !== undefined)
		: []
	let credit: LimitsProviderNotice['credit']
	if (isRecord(value.credit)) {
		const currency = text(value.credit.currency, 16)
		const used = amount(value.credit.used)
		const limit = amount(value.credit.limit)
		const remaining = amount(value.credit.remaining)
		if (
			currency !== undefined &&
			(used !== undefined || limit !== undefined || remaining !== undefined)
		)
			credit = {
				currency,
				...(used === undefined ? {} : { used }),
				...(limit === undefined ? {} : { limit }),
				...(remaining === undefined ? {} : { remaining }),
			}
	}
	let spend: LimitsProviderNotice['spend']
	if (isRecord(value.spend)) {
		const usd = amount(value.spend.usd)
		const days = amount(value.spend.days)
		if (usd !== undefined && days !== undefined && days > 0)
			spend = { usd, days, partial: value.spend.partial === true }
	}
	const plan = text(value.plan, 40)
	const asOf = amount(value.asOf)
	return {
		provider,
		label,
		kind,
		...(plan === undefined ? {} : { plan }),
		...(windows.length > 0 ? { windows } : {}),
		...(credit ? { credit } : {}),
		...(spend ? { spend } : {}),
		...(asOf === undefined ? {} : { asOf }),
	}
}

/** Admit only the known fields; an entry or a field that does not read is treated as not said. */
export function readLimitsNotice(value: unknown): LimitsNotification | undefined {
	if (!isRecord(value) || !Array.isArray(value.providers)) return undefined
	const providers = value.providers
		.slice(0, MAX_PROVIDERS)
		.map(readProvider)
		.filter((entry): entry is LimitsProviderNotice => entry !== undefined)
	return { providers }
}
