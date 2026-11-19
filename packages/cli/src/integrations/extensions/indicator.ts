/**
 * The always-visible mark. The host computes it from the live process; the extension supplies only the
 * sentence for `collecting` and `degraded` (declared in its manifest). Every other sentence is the
 * host's, fixed here, and nothing in a manifest can change, hide or reword it.
 */

export type ViewState =
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

export type IndicatorLevel = 'ok' | 'warn' | 'stopped'

export interface IndicatorView {
	level: IndicatorLevel
	label: string
}

type Table = {
	chips: Record<ViewState, string>
	starting: (n: string) => string
	notResponding: (n: string) => string
	failed: (n: string) => string
	expired: (n: string) => string
	revoked: (n: string) => string
	grace: (n: string, days: number) => string
	needsNotice: (n: string) => string
	recordingGap: string
}

const EN: Table = {
	chips: {
		added: 'Added',
		'needs-license': 'Needs a licence',
		'needs-notice': 'Needs you to read the notice',
		ready: 'Ready',
		starting: 'Starting',
		running: 'Recording',
		'not-responding': 'Not responding',
		stopped: 'Stopped',
		failed: 'Failed (Start again)',
		'license-expired': 'Stopped: licence expired',
		'license-grace': 'Licence not checked',
		'license-revoked': 'Stopped: the publisher withdrew the licence',
		'update-waiting': 'Update waiting',
	},
	starting: (n) => `Starting: ${n}`,
	notResponding: (n) => `${n} is not responding. Recording may be incomplete.`,
	failed: (n) => `${n} stopped after repeated failures. Nothing is being recorded.`,
	expired: (n) => `${n} stopped: the licence has expired. Nothing is being recorded.`,
	revoked: (n) => `${n} stopped: the publisher withdrew the licence. Nothing is being recorded.`,
	grace: (n, days) => `${n}: licence not checked, ${days} days left`,
	needsNotice: (n) => `${n} is off until you read its notice. Nothing is being recorded.`,
	recordingGap: 'Recording with a gap',
}

const TR: Table = {
	chips: {
		added: 'Eklendi',
		'needs-license': 'Lisans gerekli',
		'needs-notice': 'Bilgilendirmeyi okumanız gerekiyor',
		ready: 'Hazır',
		starting: 'Başlıyor',
		running: 'Kaydediliyor',
		'not-responding': 'Yanıt vermiyor',
		stopped: 'Durdu',
		failed: 'Başarısız (Yeniden başlat)',
		'license-expired': 'Durdu: lisansın süresi doldu',
		'license-grace': 'Lisans denetlenemedi',
		'license-revoked': 'Durdu: yayıncı lisansı geri çekti',
		'update-waiting': 'Güncelleme bekliyor',
	},
	starting: (n) => `Başlıyor: ${n}`,
	notResponding: (n) => `${n} yanıt vermiyor. Kayıt eksik olabilir.`,
	failed: (n) => `${n} tekrarlanan hatalardan sonra durdu. Hiçbir şey kaydedilmiyor.`,
	expired: (n) => `${n} durdu: lisansın süresi doldu. Hiçbir şey kaydedilmiyor.`,
	revoked: (n) => `${n} durdu: yayıncı lisansı geri çekti. Hiçbir şey kaydedilmiyor.`,
	grace: (n, days) => `${n}: lisans denetlenemedi, ${days} gün kaldı`,
	needsNotice: (n) => `${n}, bilgilendirmeyi okumanıza kadar kapalı. Hiçbir şey kaydedilmiyor.`,
	recordingGap: 'Kayıt eksik',
}

/** Namzu's own words per language; a language without a table falls back to English. */
const TABLES: Record<string, Table> = { en: EN, tr: TR }
const table = (locale: string | undefined): Table =>
	TABLES[(locale ?? 'en').split('-')[0] as string] ?? EN

export const chipFor = (state: ViewState, locale?: string, degraded = false): string =>
	state === 'running' && degraded ? table(locale).recordingGap : table(locale).chips[state]

/** `declared` is the extension's own sentence for the state it reports; null when it did not declare one. */
export function indicatorFor(input: {
	state: ViewState
	degraded: boolean
	name: string
	declared: string | null
	locale?: string
	/** The licence could not be checked but the cached answer still holds: days left of the grace. */
	graceDaysLeft?: number
}): IndicatorView | undefined {
	const t = table(input.locale)
	const { state, name } = input
	switch (state) {
		case 'running':
			if (input.graceDaysLeft !== undefined)
				return { level: 'warn', label: t.grace(name, input.graceDaysLeft) }
			return {
				level: input.degraded ? 'warn' : 'ok',
				label: input.declared ?? `${name}: ${chipFor('running', input.locale, input.degraded)}`,
			}
		case 'starting':
			return { level: 'warn', label: t.starting(name) }
		case 'not-responding':
			return { level: 'warn', label: t.notResponding(name) }
		case 'failed':
			return { level: 'stopped', label: t.failed(name) }
		case 'license-expired':
			return { level: 'stopped', label: t.expired(name) }
		case 'license-revoked':
			return { level: 'stopped', label: t.revoked(name) }
		case 'needs-notice':
			return { level: 'stopped', label: t.needsNotice(name) }
		default:
			return undefined
	}
}
