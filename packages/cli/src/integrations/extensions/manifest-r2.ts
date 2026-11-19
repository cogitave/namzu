import { KEBAB, KEY_ID, PACKAGE_PATH, type Rec, type Walk } from './manifest-walk.js'
import type { Localized, Manifest, ManifestIssue, ManifestNetworkHost } from './types.js'

/**
 * Round 2 of the manifest: the extension's own look (`ui`), starting at sign-in (`background`), the
 * three licence kinds, declared network hosts and endpoint actions. The structure follows the same
 * strict rules as round 1 (an unknown key is an error, only `x-` keys are free); `crossRules2` adds
 * what a structure check cannot say (B1 to B3, N1 to N3, A1, U2 to U8).
 */

export const BACKGROUND_PERMISSION = 'background.signin'

/** Namzu's own table of which permissions let an extension see data about the person (rule B3). */
export const PERSONAL_DATA_TABLE: Readonly<Record<string, boolean>> = {
	'os.foregroundWindow': true,
	'os.lastInputTime': true,
	'os.sessionEvents': true,
	'os.inputCounts': true,
	'os.screenChange': true,
	[BACKGROUND_PERMISSION]: false,
}

/** Ids of Namzu's own screens: a page may not take one of these names (rule U6). */
export const NAMZU_SCREEN_IDS = [
	'notice',
	'permissions',
	'license',
	'licence',
	'install',
	'remove',
	'disable',
	'consent',
	'indicator',
] as const

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/
const HOST = /^(?=.{1,253}$)(?!(?:[0-9]+\.)+[0-9]+$)(?!-)[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+$/
const BASE_URL = /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~/-]*)?$/
const BRIDGE_METHOD = /^(?:query|action):[a-z][a-z0-9-]*$/
const HOST_METHODS = ['theme', 'locale', 'state', 'openNamzu'] as const
const STATE_ID = /^[a-z][a-z0-9-]{0,23}$/
const ICON_PATH = /\.(?:svg|png)$/i

export function walkNetwork(w: Walk, v: unknown): void {
	if (!w.isObj('network', v)) return
	if (v.mode === 'none') {
		w.keys('network', v, ['mode'])
		return
	}
	if (v.mode !== 'declared') {
		w.add('network.mode', 'must be none or declared')
		return
	}
	w.keys('network', v, ['mode', 'hosts'])
	if (!w.arr('network.hosts', v.hosts, 1, 8)) return
	const seen = new Set<string>()
	v.hosts.forEach((h, i) => {
		const p = `network.hosts[${i}]`
		if (!w.isObj(p, h)) return
		w.keys(p, h, ['host', 'purpose', 'for'])
		if (w.str(`${p}.host`, h.host, HOST, 3, 253)) {
			if (seen.has(h.host)) w.add(`${p}.host`, 'listed twice')
			seen.add(h.host)
		}
		w.text(`${p}.purpose`, h.purpose, 3, 900)
		if (w.arr(`${p}.for`, h.for, 1, 3)) {
			const u = new Set<string>()
			h.for.forEach((x, j) => {
				if (!['license', 'ui', 'process'].includes(x as string))
					w.add(`${p}.for[${j}]`, 'must be license, ui or process')
				if (u.has(x as string)) w.add(`${p}.for[${j}]`, 'listed twice')
				u.add(x as string)
			})
		}
	})
}

function walkVerifier(w: Walk, path: string, v: unknown): void {
	if (!w.isObj(path, v)) return
	w.keys(path, v, ['type', 'keyId', 'keyFile'])
	if (v.type !== 'ed25519-offline') w.add(`${path}.type`, 'must be ed25519-offline')
	w.str(`${path}.keyId`, v.keyId, KEY_ID)
	w.str(`${path}.keyFile`, v.keyFile, PACKAGE_PATH, 1, 200)
}

const CLAIMS = ['customer', 'seats', 'expires', 'features']
const SENDS = ['licenseKey', 'machineHash', 'extensionId', 'extensionVersion', 'hostVersion']

function walkClaims(w: Walk, v: unknown): void {
	if (w.arr('licensing.claims', v, 0, 4))
		v.forEach((c, i) => {
			if (!CLAIMS.includes(c as string)) w.add(`licensing.claims[${i}]`, 'unknown claim')
		})
}

export function walkLicensing(w: Walk, v: unknown): void {
	if (!w.isObj('licensing', v)) return
	if (v.kind === 'none') {
		w.keys('licensing', v, ['kind'])
		return
	}
	if (v.kind === 'key') {
		w.keys('licensing', v, ['kind', 'required', 'verifier', 'claims', 'onInvalid', 'graceDays'])
		if (typeof v.required !== 'boolean') w.add('licensing.required', 'must be true or false')
		walkVerifier(w, 'licensing.verifier', v.verifier)
		walkClaims(w, v.claims)
		if (v.onInvalid !== 'disableAndExplain')
			w.add('licensing.onInvalid', 'must be disableAndExplain')
		w.int('licensing.graceDays', v.graceDays, 0, 30)
		return
	}
	if (v.kind === 'service') {
		w.keys('licensing', v, ['kind', 'required', 'service', 'claims', 'onInvalid'])
		if (typeof v.required !== 'boolean') w.add('licensing.required', 'must be true or false')
		walkClaims(w, v.claims)
		if (v.onInvalid !== 'disableAndExplain')
			w.add('licensing.onInvalid', 'must be disableAndExplain')
		const s = v.service
		if (!w.isObj('licensing.service', s)) return
		w.keys('licensing.service', s, [
			'protocol',
			'baseUrl',
			'verifier',
			'refreshHours',
			'offlineGraceDays',
			'sends',
			'releaseOnRemove',
		])
		if (s.protocol !== 'namzu-license/1')
			w.add('licensing.service.protocol', 'must be namzu-license/1')
		w.str('licensing.service.baseUrl', s.baseUrl, BASE_URL, 9, 200)
		walkVerifier(w, 'licensing.service.verifier', s.verifier)
		w.int('licensing.service.refreshHours', s.refreshHours, 1, 168)
		w.int('licensing.service.offlineGraceDays', s.offlineGraceDays, 0, 60)
		if (w.arr('licensing.service.sends', s.sends, 1, 5)) {
			const seen = new Set<string>()
			s.sends.forEach((x, i) => {
				if (!SENDS.includes(x as string))
					w.add(`licensing.service.sends[${i}]`, 'is not a field the protocol knows')
				if (seen.has(x as string)) w.add(`licensing.service.sends[${i}]`, 'listed twice')
				seen.add(x as string)
			})
		}
		if (typeof s.releaseOnRemove !== 'boolean')
			w.add('licensing.service.releaseOnRemove', 'must be true or false')
		return
	}
	w.add('licensing.kind', 'must be none, key or service')
}

export function walkBackground(w: Walk, v: unknown): void {
	if (!w.isObj('background', v)) return
	w.keys('background', v, ['runAt', 'permission', 'defaultOn', 'indicator'])
	if (v.runAt !== 'signin') w.add('background.runAt', 'must be signin')
	if (v.permission !== 'background.signin')
		w.add('background.permission', 'must be background.signin')
	if (typeof v.defaultOn !== 'boolean') w.add('background.defaultOn', 'must be true or false')
	const ind = v.indicator
	if (!w.isObj('background.indicator', ind)) return
	if (ind.kind === 'tray') {
		w.keys('background.indicator', ind, ['kind', 'label'])
		w.text('background.indicator.label', ind.label, 3, 300)
	} else if (ind.kind === 'none') {
		w.keys('background.indicator', ind, ['kind'])
	} else w.add('background.indicator.kind', 'must be tray or none')
}

export function walkManagement(w: Walk, v: unknown): void {
	if (!w.isObj('management', v)) return
	w.keys('management', v, ['lock', 'purpose'])
	if (v.lock !== 'administrator-password')
		w.add('management.lock', 'must be administrator-password')
	w.text('management.purpose', v.purpose, 3, 300)
}

export function walkActions(w: Walk, e: Rec): void {
	if (e.actions === undefined) return
	if (!w.arr('contributes.endpoint.actions', e.actions, 0, 12)) return
	e.actions.forEach((a, i) => {
		const p = `contributes.endpoint.actions[${i}]`
		if (!w.isObj(p, a)) return
		w.keys(
			p,
			a,
			['id', 'paramsSchema', 'schema', 'maxBytes', 'purpose', 'changes'],
			['needsGesture'],
		)
		w.str(`${p}.id`, a.id, KEBAB, 1, 48)
		w.str(`${p}.paramsSchema`, a.paramsSchema, PACKAGE_PATH, 1, 200)
		w.str(`${p}.schema`, a.schema, PACKAGE_PATH, 1, 200)
		w.int(`${p}.maxBytes`, a.maxBytes, 256, 1048576)
		w.text(`${p}.purpose`, a.purpose, 3, 900)
		if (!['view', 'own-settings', 'own-data-delete'].includes(a.changes as string))
			w.add(`${p}.changes`, 'must be view, own-settings or own-data-delete')
		if (a.needsGesture !== undefined && typeof a.needsGesture !== 'boolean')
			w.add(`${p}.needsGesture`, 'must be true or false')
	})
}

export function walkUi(w: Walk, v: unknown): void {
	if (!w.isObj('ui', v)) return
	w.keys('ui', v, ['icon', 'accent'], ['pages', 'chips'])
	if (w.str('ui.icon', v.icon, PACKAGE_PATH, 1, 200) && !ICON_PATH.test(v.icon))
		w.add('ui.icon', 'must be an .svg or .png file')
	w.str('ui.accent', v.accent, HEX_COLOUR)
	if (v.pages !== undefined && w.arr('ui.pages', v.pages, 0, 6)) {
		const ids = new Set<string>()
		v.pages.forEach((pg, i) => {
			const p = `ui.pages[${i}]`
			if (!w.isObj(p, pg)) return
			w.keys(
				p,
				pg,
				['id', 'title', 'slot', 'entry', 'bridge'],
				['icon', 'minHeight', 'usesNetwork'],
			)
			if (w.str(`${p}.id`, pg.id, KEBAB, 1, 48)) {
				if (ids.has(pg.id)) w.add(`${p}.id`, 'listed twice')
				ids.add(pg.id)
			}
			w.text(`${p}.title`, pg.title, 1, 200)
			if (!['sidebar', 'settings', 'panel'].includes(pg.slot as string))
				w.add(`${p}.slot`, 'must be sidebar, settings or panel')
			w.str(`${p}.entry`, pg.entry, PACKAGE_PATH, 1, 200)
			if (pg.icon !== undefined) w.str(`${p}.icon`, pg.icon, PACKAGE_PATH, 1, 200)
			if (pg.minHeight !== undefined) w.int(`${p}.minHeight`, pg.minHeight, 120, 2000)
			if (pg.usesNetwork !== undefined && typeof pg.usesNetwork !== 'boolean')
				w.add(`${p}.usesNetwork`, 'must be true or false')
			const b = pg.bridge
			if (w.isObj(`${p}.bridge`, b)) {
				w.keys(`${p}.bridge`, b, ['allow'], ['host'])
				if (w.arr(`${p}.bridge.allow`, b.allow, 0, 24)) {
					const seen = new Set<string>()
					b.allow.forEach((m, j) => {
						if (w.str(`${p}.bridge.allow[${j}]`, m, BRIDGE_METHOD)) {
							if (seen.has(m)) w.add(`${p}.bridge.allow[${j}]`, 'listed twice')
							seen.add(m)
						}
					})
				}
				if (b.host !== undefined && w.arr(`${p}.bridge.host`, b.host, 0, 4))
					b.host.forEach((m, j) => {
						if (!(HOST_METHODS as readonly string[]).includes(m as string))
							w.add(`${p}.bridge.host[${j}]`, 'must be theme, locale, state or openNamzu')
					})
			}
		})
	}
	if (v.chips !== undefined && w.arr('ui.chips', v.chips, 0, 2)) {
		const ids = new Set<string>()
		v.chips.forEach((c, i) => {
			const p = `ui.chips[${i}]`
			if (!w.isObj(p, c)) return
			w.keys(p, c, ['id', 'states'], ['opens'])
			if (w.str(`${p}.id`, c.id, KEBAB, 1, 48)) {
				if (ids.has(c.id)) w.add(`${p}.id`, 'listed twice')
				ids.add(c.id)
			}
			if (c.opens !== undefined) w.str(`${p}.opens`, c.opens, KEBAB, 1, 48)
			if (!w.isObj(`${p}.states`, c.states)) return
			const ks = Object.keys(c.states)
			if (ks.length < 1 || ks.length > 6) w.add(`${p}.states`, 'needs 1 to 6 states')
			for (const k of ks) {
				const sp = `${p}.states.${k}`
				if (!STATE_ID.test(k)) {
					w.add(sp, 'a state id is lower-case letters, digits and dashes')
					continue
				}
				const s = c.states[k]
				if (!w.isObj(sp, s)) continue
				w.keys(sp, s, ['label', 'tone'], ['icon', 'showCount'])
				w.text(`${sp}.label`, s.label, 1, 80)
				if (!['ok', 'info', 'warn'].includes(s.tone as string))
					w.add(`${sp}.tone`, 'must be ok, info or warn')
				if (s.icon !== undefined) w.str(`${sp}.icon`, s.icon, PACKAGE_PATH, 1, 200)
				if (s.showCount !== undefined && typeof s.showCount !== 'boolean')
					w.add(`${sp}.showCount`, 'must be true or false')
			}
		})
	}
}

/** Every file a manifest names for the page, chip and icon surfaces (used by K1 and the files list). */
export function uiFiles(m: Manifest): string[] {
	const out = new Set<string>()
	if (!m.ui) return []
	out.add(m.ui.icon)
	for (const p of m.ui.pages ?? []) {
		out.add(p.entry)
		if (p.icon) out.add(p.icon)
	}
	for (const c of m.ui.chips ?? [])
		for (const s of Object.values(c.states)) if (s.icon) out.add(s.icon)
	return [...out]
}

/** Texts of round 2 that count as wording (a change bumps the notice version, rule L2). */
export function wordingTexts2(m: Manifest): [string, Localized][] {
	const out: [string, Localized][] = []
	if (m.background?.indicator.kind === 'tray')
		out.push(['background.indicator.label', m.background.indicator.label])
	if (m.network.mode === 'declared')
		m.network.hosts.forEach((h, i) => out.push([`network.hosts[${i}].purpose`, h.purpose]))
	;(m.contributes.endpoint.actions ?? []).forEach((a, i) =>
		out.push([`contributes.endpoint.actions[${i}].purpose`, a.purpose]),
	)
	return out
}

/** Texts of the extension's own look: localized like the rest, but never counted as wording. */
export function lookTexts(m: Manifest): [string, Localized][] {
	const out: [string, Localized][] = []
	;(m.ui?.pages ?? []).forEach((p, i) => out.push([`ui.pages[${i}].title`, p.title]))
	;(m.ui?.chips ?? []).forEach((c, i) =>
		Object.entries(c.states).forEach(([k, s]) =>
			out.push([`ui.chips[${i}].states.${k}.label`, s.label]),
		),
	)
	return out
}

const hostsFor = (m: Manifest, use: ManifestNetworkHost['for'][number]): string[] =>
	m.network.mode === 'declared'
		? m.network.hosts.filter((h) => h.for.includes(use)).map((h) => h.host)
		: []

export function crossRules2(m: Manifest): ManifestIssue[] {
	const e: ManifestIssue[] = []
	const err = (rule: string, path: string, message: string) => e.push({ rule, path, message })
	const perms = m.permissions
	// B1: the block and the permission go together.
	const hasPerm = perms.some((p) => p.id === BACKGROUND_PERMISSION)
	if (m.background && !hasPerm)
		err('B1', 'background', 'background needs the permission background.signin, with a purpose')
	if (!m.background && hasPerm)
		err('B1', 'permissions', 'background.signin is declared but there is no background block')
	// B3: personalData follows Namzu's table for Namzu's own ids.
	perms.forEach((p, i) => {
		const known = PERSONAL_DATA_TABLE[p.id]
		if (known !== undefined && p.personalData !== known)
			err(
				'B3',
				`permissions[${i}].personalData`,
				`${p.id} must say personalData ${known}: Namzu decides this for its own permissions`,
			)
	})
	// B2: a background extension that declares personal data must show its own tray mark while it records.
	// Every other extension may declare none: the tray mark is the extension's own and optional, and
	// nothing an extension does is ever drawn on Namzu's tray icon.
	if (m.background && perms.some((p) => p.personalData && p.id !== BACKGROUND_PERMISSION)) {
		if (m.background.indicator.kind !== 'tray')
			err(
				'B2',
				'background.indicator',
				'a background extension that declares personal data must show its own tray mark while it records; every other extension may have none',
			)
	}
	// N1 to N3: the licence service and what leaves the machine.
	const lic = m.licensing
	if (lic.kind === 'service') {
		const host = /^https:\/\/([a-z0-9.-]+)/.exec(lic.service.baseUrl)?.[1]
		if (!host || !hostsFor(m, 'license').includes(host))
			err(
				'N1',
				'licensing.service.baseUrl',
				'the licence service host must be listed in network.hosts with for license',
			)
		for (const need of ['licenseKey', 'machineHash'] as const)
			if (!lic.service.sends.includes(need))
				err('N3', 'licensing.service.sends', `sends must list ${need}`)
	}
	const nonLicence = (m.network.mode === 'declared' ? m.network.hosts : []).some((h) =>
		h.for.some((u) => u !== 'license'),
	)
	const any = m.network.mode === 'declared' && m.network.hosts.length > 0
	const want = !any ? 'nothing' : nonLicence ? 'declared' : 'licence-check-only'
	if (m.privacy.leavesTheMachine !== want)
		err(
			'N2',
			'privacy.leavesTheMachine',
			`with these network hosts it must be ${want}, not ${m.privacy.leavesTheMachine}`,
		)
	// A1: actions need the /2 protocol.
	const ep = m.contributes.endpoint
	if ((ep.actions?.length ?? 0) > 0 && ep.protocol !== 'namzu-ext-query/2')
		err('A1', 'contributes.endpoint.protocol', 'actions need the protocol namzu-ext-query/2')
	const methods = new Set([
		...ep.queries.map((q) => `query:${q.id}`),
		...(ep.actions ?? []).map((a) => `action:${a.id}`),
	])
	for (const [i, a] of (ep.actions ?? []).entries())
		if (ep.queries.some((q) => q.id === a.id))
			err('A1', `contributes.endpoint.actions[${i}].id`, 'an action id may not repeat a query id')
	// U rules.
	const pageIds = new Set((m.ui?.pages ?? []).map((p) => p.id))
	const uiHosts = hostsFor(m, 'ui')
	;(m.ui?.pages ?? []).forEach((p, i) => {
		const path = `ui.pages[${i}]`
		for (const [j, b] of p.bridge.allow.entries())
			if (!methods.has(b))
				err('U2', `${path}.bridge.allow[${j}]`, `${b} is not declared in contributes.endpoint`)
		if (!p.entry.startsWith('ui/') || !p.entry.endsWith('.html'))
			err('U3', `${path}.entry`, 'a page is an .html file under ui/')
		if (p.usesNetwork === true && uiHosts.length === 0)
			err('U4', `${path}.usesNetwork`, 'usesNetwork needs a host in network.hosts with for ui')
		if ((NAMZU_SCREEN_IDS as readonly string[]).includes(p.id))
			err('U6', `${path}.id`, `${p.id} is the name of one of Namzu's own screens`)
		if (p.usesNetwork === true && p.bridge.allow.length > 0)
			err(
				'U7',
				path,
				'a page that uses the network cannot also call the extension: it may have data or network, not both',
			)
	})
	if (m.privacy.monitoringKind !== 'none') {
		const ok = m.contributes.pages.some((p) => p.view === 'builtin:what-is-collected')
		if (!ok)
			err(
				'U5',
				'contributes.pages',
				'a monitoring extension must carry Namzu\'s own "What is collected" page (builtin:what-is-collected)',
			)
	}
	;(m.ui?.chips ?? []).forEach((c, i) => {
		if (c.opens !== undefined && !pageIds.has(c.opens))
			err('U8', `ui.chips[${i}].opens`, `${c.opens} is not a page of this extension`)
	})
	return e
}
