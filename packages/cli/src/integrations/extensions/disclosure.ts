import { licenceRequired } from './license/kind.js'
import { pickLocale, resolveLocale } from './manifest.js'
import type { Manifest } from './types.js'

/**
 * What the person is told before an extension can run, drawn from the manifest and nothing else.
 * `add`, the install dialog, the notice screen and "What is collected" all read this one function, so
 * there is no second description that could disagree.
 */
export interface Disclosure {
	extensionId: string
	name: string
	version: string
	publisher: { name: string; contact: string }
	shownLocale: string
	/** Set when the package has no text in the person's language and the default is shown instead. */
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
	/** Starts at sign-in: the permission's words and what the extension shows while Namzu is closed. */
	background?: { line: string; whileClosed: string; defaultOn: boolean }
	/** The pages the extension draws inside Namzu and what they may reach. */
	pages?: string
	/** An extension an administrator locks: who can turn it off, and why it is built that way. */
	management?: { line: string; purpose: string }
	noticeVersion: string
}

const joinWords = (parts: string[]): string =>
	parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`

const SENDS_WORDS: Record<string, string> = {
	licenseKey: 'your licence key',
	machineHash: 'a code for this computer',
	extensionId: 'the extension name',
	extensionVersion: 'the extension version',
	hostVersion: 'the Namzu version',
}

function licenceWords(m: Manifest): string {
	const l = m.licensing
	if (l.kind === 'none') return 'No licence needed.'
	if (l.kind === 'key') return 'A licence key file is needed.'
	const host = /^https:\/\/([^/]+)/.exec(l.service.baseUrl)?.[1] ?? ''
	const sends = joinWords(l.service.sends.map((s) => SENDS_WORDS[s] ?? s))
	return `Licence check: contacts ${host} to check your licence key. It sends: ${sends}. It checks every ${l.service.refreshHours} hours and keeps working offline for ${l.service.offlineGraceDays} days. It sends nothing else.`
}

function networkWords(m: Manifest, t: (x: Readonly<Record<string, string>>) => string): string {
	if (m.network.mode === 'none') return 'It does not use the network.'
	return `Network: only ${m.network.hosts.map((h) => `${h.host} (${h.for.join(', ')}): ${t(h.purpose)}`).join('; ')}.`
}

function leavesWords(m: Manifest): string {
	const v = m.privacy.leavesTheMachine
	if (v === 'nothing') return 'Nothing leaves this computer.'
	if (v === 'licence-check-only')
		return 'Only the licence check leaves this computer, and only the fields listed above.'
	return 'Something leaves this computer.'
}

/** The names of common languages in themselves; the runtime's own table is the fallback, then the tag. */
const OWN_NAMES: Record<string, string> = {
	en: 'English',
	tr: 'Türkçe',
	de: 'Deutsch',
	fr: 'Français',
	es: 'Español',
	it: 'Italiano',
	pt: 'Português',
	nl: 'Nederlands',
	pl: 'Polski',
	ru: 'Русский',
	ja: '日本語',
	zh: '中文',
	ko: '한국어',
	ar: 'العربية',
}

/** The two storage phrases are shown one after the other, so each must end like a sentence. */
/** A notice file may open with comment lines for its maker (the language, a draft mark); the person is shown none of them. */
export function stripLeadingComments(text: string): string {
	return text.replace(/^(?:\s*<!--[\s\S]*?-->[ \t]*\n?)+/, '')
}

export function endSentence(text: string): string {
	const t = text.trim()
	return /[.!?…。]$/.test(t) ? t : `${t}.`
}

export function localeName(tag: string): string {
	const own = OWN_NAMES[tag.split('-')[0] as string]
	if (own) return own
	try {
		return new Intl.DisplayNames([tag], { type: 'language' }).of(tag.split('-')[0] as string) ?? tag
	} catch {
		return tag
	}
}

export function disclose(m: Manifest, wanted: string | undefined, dataFolder: string): Disclosure {
	const { locale, available } = resolveLocale(m, wanted)
	const t = (x: Readonly<Record<string, string>>): string =>
		pickLocale(x, locale, m.defaultLocale).text
	return {
		extensionId: m.id,
		name: t(m.name),
		version: m.version,
		publisher: { name: m.publisher.name, contact: m.publisher.contact },
		shownLocale: locale,
		...(available
			? {}
			: {
					languageNote: `This extension is not available in your language. Showing ${localeName(m.defaultLocale)}.`,
				}),
		permissions: m.permissions.map((p) => ({
			id: p.id,
			level: p.level,
			optional: p.optional,
			summary: t(p.summary),
			purposes: p.purposes.map((u) => t(u.text)),
			...(p.prompt ? { prompt: t(p.prompt) } : {}),
		})),
		network: networkWords(m, t),
		dataFolder,
		dataKinds: m.produces.map((d) => ({
			id: d.id,
			description: t(d.description),
			fields: d.fields.map((f) => ({
				name: f.name,
				description: t(f.description),
			})),
			retentionDays: d.retentionDays,
		})),
		doesNotCollect: m.privacy.doesNotCollect.map(t),
		doesNotDo: m.privacy.doesNotDo.map(t),
		storage: {
			where: endSentence(t(m.privacy.storage.where)),
			encryption: endSentence(t(m.privacy.storage.encryption)),
			adminCanRead: m.privacy.storage.adminCanRead,
		},
		leavesTheMachine: leavesWords(m),
		controller: t(m.privacy.controller),
		licenseRequired: licenceRequired(m),
		licence: licenceWords(m),
		...(m.background
			? {
					background: {
						line: 'Starts when you sign in and keeps running when Namzu is closed.',
						whileClosed:
							m.background.indicator.kind === 'tray'
								? `While Namzu is closed it shows: ${t(m.background.indicator.label)}`
								: 'It shows nothing of its own while Namzu is closed.',
						defaultOn: m.background.defaultOn,
					},
				}
			: {}),
		...(m.ui?.pages?.length
			? {
					pages: `This extension draws pages inside Namzu: ${(m.ui.pages ?? []).map((p) => `${t(p.title)} (${p.slot})`).join(', ')}. ${(m.ui.pages ?? []).some((p) => p.usesNetwork) ? 'Some of them can reach the network.' : 'They cannot use the network.'}`,
				}
			: {}),
		...(m.management
			? {
					management: {
						line: 'Only the administrator can turn this off or remove it. It is turned on with an administrator password, and without that password nobody can turn it off, remove it, change its licence or take its permissions back in Namzu.',
						purpose: endSentence(t(m.management.purpose)),
					},
				}
			: {}),
		noticeVersion: m.legal.noticeVersion,
	}
}

/** The disclosure as lines for a terminal. */
export function disclosureText(d: Disclosure): string {
	const out: string[] = []
	out.push(`${d.name} ${d.version}`, `Publisher: ${d.publisher.name} (${d.publisher.contact})`)
	if (d.languageNote) out.push(d.languageNote)
	out.push('', 'It asks for:')
	for (const p of d.permissions) {
		out.push(
			`  ${p.id} [${p.level}${p.optional ? ', optional: asked for later' : ''}]`,
			`    ${p.summary}`,
		)
		for (const u of p.purposes) out.push(`    Why: ${u}`)
	}
	out.push('', d.network, `Data folder: ${d.dataFolder}`)
	if (d.background) out.push('', d.background.line, d.background.whileClosed)
	if (d.pages) out.push('', d.pages)
	if (d.management) out.push('', d.management.line, d.management.purpose)
	out.push('', 'It keeps:')
	for (const k of d.dataKinds) {
		out.push(
			`  ${k.id}: ${k.description} ${k.retentionDays === 'keep' ? 'Kept until your organisation deletes it.' : `Kept ${k.retentionDays} days.`}`,
		)
		out.push(`    Fields: ${k.fields.map((f) => f.name).join(', ')}`)
	}
	if (d.doesNotCollect.length)
		out.push('', 'It does not collect:', ...d.doesNotCollect.map((x) => `  - ${x}`))
	if (d.doesNotDo.length) out.push('', 'It does not:', ...d.doesNotDo.map((x) => `  - ${x}`))
	out.push('', `Stored: ${d.storage.where} ${d.storage.encryption}`)
	if (d.storage.adminCanRead)
		out.push('An administrator of this computer can get around this protection.')
	out.push(
		d.leavesTheMachine,
		`Licence needed: ${d.licenseRequired ? 'yes' : 'no'}`,
		d.licence,
		`Notice version: ${d.noticeVersion}`,
	)
	return out.join('\n')
}

/** The permission list in words, as the notice screen repeats it. */
export function scopeWords(d: Disclosure): string[] {
	return d.permissions.flatMap((p) => [
		`${p.summary}${p.optional ? ' (optional, asked for later)' : ''}`,
		...p.purposes.map((u) => `  ${u}`),
	])
}
