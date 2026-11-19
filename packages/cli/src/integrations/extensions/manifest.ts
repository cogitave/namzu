import {
	BACKGROUND_PERMISSION,
	crossRules2,
	lookTexts,
	walkActions,
	walkBackground,
	walkLicensing,
	walkNetwork,
	walkUi,
	wordingTexts2,
} from './manifest-r2.js'
import {
	BAD_FIELD,
	DATA_ID,
	ENV_NAME,
	ENV_VALUE,
	FIELD_NAME,
	ID,
	ID_REFUSAL,
	KEBAB,
	KEY_ID,
	MANIFEST_MAX_BYTES,
	MAX_DEPTH,
	NEVER_PERMISSIONS,
	NOTICE_VERSION,
	PACKAGE_PATH,
	PHASE1_PERMISSIONS,
	PLATFORMS,
	RANGE,
	RESERVED_CONTRIBUTES,
	RESERVED_PERMISSIONS,
	RESERVED_TOP,
	type Rec,
	SECRETY,
	SEMVER,
	SHA256,
	TAG,
	Walk,
	X_PERMISSION,
} from './manifest-walk.js'
import type { Localized, Manifest, ManifestIssue } from './types.js'

export { MANIFEST_MAX_BYTES, PLATFORMS, PHASE1_PERMISSIONS }

function permissionId(w: Walk, path: string, v: unknown): void {
	if (!w.str(path, v, undefined, 1, 64)) return
	if (RESERVED_PERMISSIONS.includes(v)) {
		w.add(path, `${v} is reserved for a later phase and is refused in phase 1`)
		return
	}
	if (NEVER_PERMISSIONS.includes(v)) {
		w.add(path, `${v} is never offered by Namzu`)
		return
	}
	if (
		(PHASE1_PERMISSIONS as readonly string[]).includes(v) ||
		v === BACKGROUND_PERMISSION ||
		X_PERMISSION.test(v)
	)
		return
	w.add(path, `${v} is not a permission Namzu knows (use one of the phase 1 ids or x-<your own>)`)
}

function walkPermissions(w: Walk, v: unknown): void {
	if (!w.arr('permissions', v, 1, 24)) return
	v.forEach((p, i) => {
		const path = `permissions[${i}]`
		if (!w.isObj(path, p)) return
		w.keys(path, p, ['id', 'level', 'optional', 'summary', 'purposes', 'personalData'], ['prompt'])
		if (typeof p.personalData !== 'boolean') w.add(`${path}.personalData`, 'must be true or false')
		permissionId(w, `${path}.id`, p.id)
		if (!['low', 'medium', 'high'].includes(p.level as string))
			w.add(`${path}.level`, 'must be low, medium or high')
		if (typeof p.optional !== 'boolean') w.add(`${path}.optional`, 'must be true or false')
		w.text(`${path}.summary`, p.summary, 3, 900)
		if (p.purposes === undefined || (Array.isArray(p.purposes) && p.purposes.length === 0)) {
			// The rule the owner asked for, in plain words.
			w.add(
				`${path}.purposes`,
				`permission ${String(p.id)} has no purpose: every permission must say why it is asked`,
				'P0',
			)
		} else if (w.arr(`${path}.purposes`, p.purposes, 1, 6)) {
			p.purposes.forEach((u, j) => {
				const up = `${path}.purposes[${j}]`
				if (!w.isObj(up, u)) return
				w.keys(up, u, ['id', 'text'])
				w.str(`${up}.id`, u.id, KEBAB, 1, 48)
				w.text(`${up}.text`, u.text, 3, 900)
			})
		}
		if (p.optional === true) {
			if (p.prompt === undefined)
				w.add(`${path}.prompt`, 'an optional permission needs the words of its later prompt')
			else w.text(`${path}.prompt`, p.prompt, 3, 900)
		} else if (p.prompt !== undefined)
			w.add(`${path}.prompt`, 'only an optional permission has a prompt')
	})
}

function walkProduces(w: Walk, v: unknown): void {
	if (!w.arr('produces', v, 1, 24)) return
	v.forEach((d, i) => {
		const path = `produces[${i}]`
		if (!w.isObj(path, d)) return
		w.keys(path, d, [
			'id',
			'from',
			'description',
			'grain',
			'fields',
			'retentionDays',
			'leavesMachine',
		])
		w.str(`${path}.id`, d.id, DATA_ID, 1, 64)
		if (w.arr(`${path}.from`, d.from, 1, 24))
			d.from.forEach((f, j) => permissionId(w, `${path}.from[${j}]`, f))
		w.text(`${path}.description`, d.description, 3, 900)
		if (!['minute', 'event'].includes(d.grain as string))
			w.add(`${path}.grain`, 'must be minute or event')
		if (w.arr(`${path}.fields`, d.fields, 1, 24))
			d.fields.forEach((f, j) => {
				const fp = `${path}.fields[${j}]`
				if (!w.isObj(fp, f)) return
				w.keys(fp, f, ['name', 'type', 'description'])
				w.str(`${fp}.name`, f.name, FIELD_NAME, 1, 32)
				if (!['integer', 'text', 'timestamp'].includes(f.type as string))
					w.add(`${fp}.type`, 'must be integer, text or timestamp')
				w.text(`${fp}.description`, f.description, 1, 200)
			})
		w.int(`${path}.retentionDays`, d.retentionDays, 1, 365)
		if (d.leavesMachine !== false)
			w.add(`${path}.leavesMachine`, 'phase 1: data never leaves the machine (must be false)')
	})
}

function walkEntry(w: Walk, v: unknown): void {
	if (!w.isObj('entry', v)) return
	w.keys('entry', v, ['process'], ['maintenance'])
	const p = v.process
	if (w.isObj('entry.process', p)) {
		w.keys(
			'entry.process',
			p,
			['id', 'command', 'cwd', 'scope', 'start', 'restart', 'stopGraceMs'],
			['env', 'runAtLogin'],
		)
		w.str('entry.process.id', p.id, /^[a-z][a-z0-9-]{0,31}$/)
		w.command('entry.process.command', p.command)
		if (p.cwd !== '${extensionDir}') w.add('entry.process.cwd', 'must be ${extensionDir}')
		if (p.scope !== 'per-user-session') w.add('entry.process.scope', 'must be per-user-session')
		if (p.start !== 'onEnable') w.add('entry.process.start', 'must be onEnable')
		if (p.runAtLogin !== undefined)
			w.add(
				'entry.process.runAtLogin',
				'was removed in round 2: declare a background block instead',
			)
		w.int('entry.process.stopGraceMs', p.stopGraceMs, 1000, 30000)
		if (p.env !== undefined && w.isObj('entry.process.env', p.env)) {
			const ks = Object.keys(p.env)
			if (ks.length > 16) w.add('entry.process.env', 'at most 16 variables')
			for (const k of ks) {
				if (!ENV_NAME.test(k)) w.add(`entry.process.env.${k}`, 'bad variable name')
				else w.str(`entry.process.env.${k}`, p.env[k], ENV_VALUE, 0, 300)
			}
		}
		const r = p.restart
		if (w.isObj('entry.process.restart', r)) {
			w.keys('entry.process.restart', r, ['policy', 'backoffMs', 'maxPerHour', 'stableAfterMs'])
			if (!['onFailure', 'never'].includes(r.policy as string))
				w.add('entry.process.restart.policy', 'must be onFailure or never')
			if (w.arr('entry.process.restart.backoffMs', r.backoffMs, 1, 8))
				r.backoffMs.forEach((b, i) =>
					w.int(`entry.process.restart.backoffMs[${i}]`, b, 500, 3600000),
				)
			w.int('entry.process.restart.maxPerHour', r.maxPerHour, 1, 60)
			w.int('entry.process.restart.stableAfterMs', r.stableAfterMs, 60000, 3600000)
		}
	}
	if (v.maintenance !== undefined) {
		const m = v.maintenance
		if (w.isObj('entry.maintenance', m)) {
			w.keys('entry.maintenance', m, ['command', 'runWhen'], ['timeoutMs'])
			w.command('entry.maintenance.command', m.command)
			if (w.arr('entry.maintenance.runWhen', m.runWhen, 1, 4))
				m.runWhen.forEach((x, i) => {
					if (!['hostStart', 'daily', 'onDisable', 'onLicenseExpired'].includes(x as string))
						w.add(`entry.maintenance.runWhen[${i}]`, 'unknown trigger')
				})
			if (m.timeoutMs !== undefined) w.int('entry.maintenance.timeoutMs', m.timeoutMs, 1000, 120000)
		}
	}
}

function walkContributes(w: Walk, v: unknown): void {
	if (!w.isObj('contributes', v)) return
	w.keys('contributes', v, ['endpoint', 'pages', 'indicator'], ['settings'], RESERVED_CONTRIBUTES)
	const e = v.endpoint
	if (w.isObj('contributes.endpoint', e)) {
		w.keys('contributes.endpoint', e, ['protocol', 'name', 'queries'], ['actions'])
		if (e.protocol !== 'namzu-ext-query/1' && e.protocol !== 'namzu-ext-query/2')
			w.add('contributes.endpoint.protocol', 'must be namzu-ext-query/1 or namzu-ext-query/2')
		walkActions(w, e)
		w.str('contributes.endpoint.name', e.name, /^[a-z][a-z0-9-]{2,40}$/)
		if (w.arr('contributes.endpoint.queries', e.queries, 1, 12))
			e.queries.forEach((q, i) => {
				const qp = `contributes.endpoint.queries[${i}]`
				if (!w.isObj(qp, q)) return
				w.keys(qp, q, ['id', 'returns', 'schema', 'maxBytes', 'purpose'])
				w.str(`${qp}.id`, q.id, KEBAB, 1, 48)
				if (w.arr(`${qp}.returns`, q.returns, 0, 24))
					q.returns.forEach((r, j) => w.str(`${qp}.returns[${j}]`, r, DATA_ID, 1, 64))
				w.str(`${qp}.schema`, q.schema, PACKAGE_PATH, 1, 200)
				w.int(`${qp}.maxBytes`, q.maxBytes, 256, 4194304)
				w.text(`${qp}.purpose`, q.purpose, 3, 900)
			})
	}
	if (v.settings !== undefined && w.arr('contributes.settings', v.settings, 0, 8))
		v.settings.forEach((s, i) => {
			const sp = `contributes.settings[${i}]`
			if (!w.isObj(sp, s)) return
			w.keys(sp, s, ['key', 'type', 'label', 'purpose'], ['perProvider', 'usedBy', 'storage'])
			w.str(`${sp}.key`, s.key, FIELD_NAME, 1, 32)
			if (!['secret', 'toggle', 'number', 'text'].includes(s.type as string))
				w.add(`${sp}.type`, 'must be secret, toggle, number or text')
			w.text(`${sp}.label`, s.label, 3, 900)
			w.text(`${sp}.purpose`, s.purpose, 3, 900)
			if (s.usedBy !== undefined && s.usedBy !== 'none')
				w.add(`${sp}.usedBy`, 'phase 1: a setting is used by nothing (analysis is phase 3)')
			if (s.storage !== undefined && s.storage !== 'hostKeysFile')
				w.add(`${sp}.storage`, 'must be hostKeysFile')
			if (s.type === 'secret') {
				if (s.usedBy === undefined) w.add(`${sp}.usedBy`, 'is required for a secret')
				if (s.storage === undefined) w.add(`${sp}.storage`, 'is required for a secret')
			}
		})
	if (w.arr('contributes.pages', v.pages, 0, 4))
		v.pages.forEach((p, i) => {
			const pp = `contributes.pages[${i}]`
			if (!w.isObj(pp, p)) return
			w.keys(pp, p, ['id', 'title', 'location', 'view', 'source'])
			w.str(`${pp}.id`, p.id, KEBAB, 1, 48)
			w.text(`${pp}.title`, p.title, 1, 200)
			if (p.location !== 'desktop.settings') w.add(`${pp}.location`, 'must be desktop.settings')
			if (p.view !== 'builtin:what-is-collected')
				w.add(`${pp}.view`, 'must be builtin:what-is-collected')
			if (w.isObj(`${pp}.source`, p.source)) {
				w.keys(`${pp}.source`, p.source, ['kind', 'counts'])
				if (p.source.kind !== 'privacy') w.add(`${pp}.source.kind`, 'must be privacy')
				w.str(`${pp}.source.counts`, p.source.counts, /^query:[a-z][a-z0-9-]*$/)
			}
		})
	const ind = v.indicator
	if (w.isObj('contributes.indicator', ind)) {
		w.keys('contributes.indicator', ind, ['id', 'locations', 'alwaysVisibleWhenRunning', 'states'])
		w.str('contributes.indicator.id', ind.id, KEBAB, 1, 48)
		if (w.arr('contributes.indicator.locations', ind.locations, 1, 3))
			ind.locations.forEach((l, i) => {
				if (!['desktop.tray', 'desktop.titlebar', 'cli.statusline'].includes(l as string))
					w.add(`contributes.indicator.locations[${i}]`, 'unknown location')
			})
		if (ind.alwaysVisibleWhenRunning !== true)
			w.add(
				'contributes.indicator.alwaysVisibleWhenRunning',
				'an extension cannot ask to be hidden: must be true',
			)
		const st = ind.states
		if (w.isObj('contributes.indicator.states', st)) {
			w.keys('contributes.indicator.states', st, ['collecting'], ['degraded'])
			for (const k of ['collecting', 'degraded']) {
				const s = st[k]
				if (s === undefined) continue
				if (!w.isObj(`contributes.indicator.states.${k}`, s)) continue
				w.keys(`contributes.indicator.states.${k}`, s, ['label'])
				w.text(`contributes.indicator.states.${k}.label`, s.label, 1, 200)
			}
		}
	}
}

function walkPrivacyLegal(w: Walk, m: Rec): void {
	const pr = m.privacy
	if (w.isObj('privacy', pr)) {
		w.keys('privacy', pr, [
			'doesNotCollect',
			'doesNotDo',
			'storage',
			'leavesTheMachine',
			'controller',
			'rights',
			'monitoringKind',
		])
		if (w.arr('privacy.doesNotCollect', pr.doesNotCollect, 1, 30))
			pr.doesNotCollect.forEach((t, i) => w.text(`privacy.doesNotCollect[${i}]`, t, 1, 200))
		if (w.arr('privacy.doesNotDo', pr.doesNotDo, 0, 20))
			pr.doesNotDo.forEach((t, i) => w.text(`privacy.doesNotDo[${i}]`, t, 1, 200))
		const s = pr.storage
		if (w.isObj('privacy.storage', s)) {
			w.keys('privacy.storage', s, ['where', 'encryption', 'adminCanRead'])
			w.text('privacy.storage.where', s.where, 1, 200)
			w.text('privacy.storage.encryption', s.encryption, 1, 200)
			if (typeof s.adminCanRead !== 'boolean')
				w.add('privacy.storage.adminCanRead', 'must be true or false')
		}
		if (!['nothing', 'licence-check-only', 'declared'].includes(pr.leavesTheMachine as string))
			w.add('privacy.leavesTheMachine', 'must be nothing, licence-check-only or declared')
		w.text('privacy.controller', pr.controller, 1, 200)
		if (w.isObj('privacy.rights', pr.rights)) {
			w.keys('privacy.rights', pr.rights, ['view', 'delete'])
			if (pr.rights.view !== true) w.add('privacy.rights.view', 'must be true')
			w.text('privacy.rights.delete', pr.rights.delete, 1, 200)
		}
		if (!['none', 'employee-activity', 'device'].includes(pr.monitoringKind as string))
			w.add(
				'privacy.monitoringKind',
				'must be none, employee-activity or device (content is not accepted)',
			)
	}
	const lg = m.legal
	if (w.isObj('legal', lg)) {
		w.keys('legal', lg, ['noticeVersion', 'notices', 'acknowledgement', 'jurisdictions'])
		w.str('legal.noticeVersion', lg.noticeVersion, NOTICE_VERSION)
		if (w.isObj('legal.notices', lg.notices)) {
			const ks = Object.keys(lg.notices)
			if (ks.length === 0) w.add('legal.notices', 'needs at least one notice')
			for (const k of ks) {
				const n = lg.notices[k]
				if (!TAG.test(k)) w.add('legal.notices', `bad locale tag ${k}`)
				if (!w.isObj(`legal.notices.${k}`, n)) continue
				w.keys(`legal.notices.${k}`, n, ['file', 'sha256'])
				w.str(`legal.notices.${k}.file`, n.file, PACKAGE_PATH, 1, 200)
				w.str(`legal.notices.${k}.sha256`, n.sha256, SHA256)
			}
		}
		if (w.isObj('legal.acknowledgement', lg.acknowledgement)) {
			w.keys('legal.acknowledgement', lg.acknowledgement, ['mode', 'retainDays'])
			if (!['inform', 'inform-and-acknowledge'].includes(lg.acknowledgement.mode as string))
				w.add('legal.acknowledgement.mode', 'must be inform or inform-and-acknowledge')
			w.int('legal.acknowledgement.retainDays', lg.acknowledgement.retainDays, 30, 3650)
		}
		if (w.arr('legal.jurisdictions', lg.jurisdictions, 1, 50))
			lg.jurisdictions.forEach((j, i) => w.str(`legal.jurisdictions[${i}]`, j, /^[A-Z]{2}$/))
	}
}

function walkRest(w: Walk, m: Rec): void {
	walkLicensing(w, m.licensing)
	const r = m.resources
	if (w.isObj('resources', r)) {
		w.keys('resources', r, [
			'maxMemoryMB',
			'cpuSharePercent',
			'maxDiskMB',
			'onExceed',
			'enforcement',
		])
		w.int('resources.maxMemoryMB', r.maxMemoryMB, 8, 512)
		w.int('resources.cpuSharePercent', r.cpuSharePercent, 1, 25)
		w.int('resources.maxDiskMB', r.maxDiskMB, 1, 1024)
		if (!['report', 'stop'].includes(r.onExceed as string))
			w.add('resources.onExceed', 'must be report or stop')
		if (r.enforcement !== 'report')
			w.add('resources.enforcement', 'phase 1: limits are reported, not enforced (must be report)')
	}
	const u = m.updates
	if (w.isObj('updates', u)) {
		w.keys('updates', u, ['channel', 'permissionChange', 'autoUpdate'], [], ['source'])
		w.str('updates.channel', u.channel, /^[a-z][a-z0-9-]{0,31}$/)
		if (u.permissionChange !== 'askAgain') w.add('updates.permissionChange', 'must be askAgain')
		if (u.autoUpdate !== 'never')
			w.add('updates.autoUpdate', 'phase 1: Namzu never fetches a package (must be never)')
	}
	const s = m.signing
	if (w.isObj('signing', s)) {
		w.keys('signing', s, ['publisherKeyId', 'manifestSignature', 'files'], ['platformSignatures'])
		w.str('signing.publisherKeyId', s.publisherKeyId, KEY_ID)
		if (s.manifestSignature !== 'signatures/manifest.sig')
			w.add('signing.manifestSignature', 'must be signatures/manifest.sig')
		if (s.files !== 'files.sha256.json') w.add('signing.files', 'must be files.sha256.json')
		if (
			s.platformSignatures !== undefined &&
			w.isObj('signing.platformSignatures', s.platformSignatures)
		) {
			w.keys('signing.platformSignatures', s.platformSignatures, [], ['win32'])
			if (s.platformSignatures.win32 !== undefined && s.platformSignatures.win32 !== 'authenticode')
				w.add('signing.platformSignatures.win32', 'must be authenticode')
		}
	}
	walkNetwork(w, m.network)
	if (w.arr('files', m.files, 0, 4))
		m.files.forEach((f, i) => {
			const fp = `files[${i}]`
			if (!w.isObj(fp, f)) return
			w.keys(fp, f, ['path', 'access', 'purpose'])
			if (f.path !== '${dataDir}') w.add(`${fp}.path`, 'phase 1: only ${dataDir}')
			if (f.access !== 'readWrite') w.add(`${fp}.access`, 'must be readWrite')
			w.text(`${fp}.purpose`, f.purpose, 3, 900)
		})
	const pub = m.publisher
	if (w.isObj('publisher', pub)) {
		w.keys('publisher', pub, ['id', 'name', 'contact'], ['homepage'])
		w.str('publisher.id', pub.id, /^[a-z][a-z0-9-]{1,39}$/)
		w.str('publisher.name', pub.name, undefined, 1, 80)
		if (pub.homepage !== undefined) w.str('publisher.homepage', pub.homepage, /^https:\/\//, 0, 200)
		w.str('publisher.contact', pub.contact, undefined, 3, 120)
	}
	const en = m.engines
	if (w.isObj('engines', en)) {
		w.keys('engines', en, ['namzu', 'extensionApi'], ['desktop'])
		w.str('engines.namzu', en.namzu, RANGE, 1, 80)
		if (en.desktop !== undefined) w.str('engines.desktop', en.desktop, RANGE, 1, 80)
		if (en.extensionApi !== '1') w.add('engines.extensionApi', 'must be "1"')
	}
	if (w.arr('platforms', m.platforms, 1, 6)) {
		const seen = new Set<string>()
		m.platforms.forEach((p, i) => {
			if (!(PLATFORMS as readonly string[]).includes(p as string))
				w.add(`platforms[${i}]`, 'unknown platform')
			if (seen.has(p as string)) w.add(`platforms[${i}]`, 'listed twice')
			seen.add(p as string)
		})
	}
}

export function localizedTexts(m: Manifest): [string, Localized][] {
	const out: [string, Localized][] = []
	const add = (p: string, v: Localized | undefined) => {
		if (v !== undefined) out.push([p, v])
	}
	add('name', m.name)
	add('description', m.description)
	m.permissions.forEach((p, i) => {
		add(`permissions[${i}].summary`, p.summary)
		add(`permissions[${i}].prompt`, p.prompt)
		p.purposes.forEach((u, j) => add(`permissions[${i}].purposes[${j}].text`, u.text))
	})
	m.produces.forEach((d, i) => {
		add(`produces[${i}].description`, d.description)
		d.fields.forEach((f, j) => add(`produces[${i}].fields[${j}].description`, f.description))
	})
	const pr = m.privacy
	pr.doesNotCollect.forEach((t, i) => add(`privacy.doesNotCollect[${i}]`, t))
	pr.doesNotDo.forEach((t, i) => add(`privacy.doesNotDo[${i}]`, t))
	add('privacy.storage.where', pr.storage.where)
	add('privacy.storage.encryption', pr.storage.encryption)
	add('privacy.controller', pr.controller)
	add('privacy.rights.delete', pr.rights.delete)
	m.files.forEach((f, i) => add(`files[${i}].purpose`, f.purpose))
	m.contributes.endpoint.queries.forEach((q, i) =>
		add(`contributes.endpoint.queries[${i}].purpose`, q.purpose),
	)
	;(m.contributes.settings ?? []).forEach((s, i) => {
		add(`contributes.settings[${i}].label`, s.label)
		add(`contributes.settings[${i}].purpose`, s.purpose)
	})
	m.contributes.pages.forEach((p, i) => add(`contributes.pages[${i}].title`, p.title))
	for (const [p, t] of wordingTexts2(m)) add(p, t)
	for (const [k, v] of Object.entries(m.contributes.indicator.states))
		add(`contributes.indicator.states.${k}.label`, v?.label)
	return out
}

/** Texts that are localized but never counted as wording: the extension's own look. */
export const lookTextsOf = lookTexts

/** The rules a schema cannot say (L1 to L3, P1 to P4, Q1, Q2, E1, E2, S1, D1). */
export function crossRules(m: Manifest): ManifestIssue[] {
	const e: ManifestIssue[] = []
	const err = (rule: string, path: string, message: string) => e.push({ rule, path, message })
	const dup = (arr: string[]) => arr.filter((x, i) => arr.indexOf(x) !== i)
	if (!m.locales.includes(m.defaultLocale))
		err('L1', 'locales', 'locales must contain defaultLocale')
	for (const [p, t] of [...localizedTexts(m), ...lookTexts(m)]) {
		if (typeof t[m.defaultLocale] !== 'string')
			err('L2', p, `no text in defaultLocale ${m.defaultLocale}`)
		for (const k of Object.keys(t)) {
			if (!TAG.test(k)) err('L2', p, `bad locale tag ${k}`)
			else if (!m.locales.includes(k)) err('L2', p, `locale ${k} is not listed in locales`)
		}
	}
	const nl = Object.keys(m.legal.notices)
	if (!nl.includes(m.defaultLocale)) err('L3', 'legal.notices', 'no notice in defaultLocale')
	for (const k of nl)
		if (!m.locales.includes(k))
			err('L3', 'legal.notices', `notice locale ${k} is not listed in locales`)
	const permIds = m.permissions.map((p) => p.id)
	for (const d of dup(permIds)) err('P1', 'permissions', `duplicate permission ${d}`)
	m.permissions.forEach((p, i) => {
		for (const d of dup(p.purposes.map((u) => u.id)))
			err('P1', `permissions[${i}].purposes`, `duplicate purpose ${d}`)
	})
	const prodIds = m.produces.map((d) => d.id)
	for (const d of dup(prodIds)) err('P1', 'produces', `duplicate data kind ${d}`)
	const used = new Set<string>()
	m.produces.forEach((d, i) =>
		d.from.forEach((f) => {
			used.add(f)
			if (!permIds.includes(f))
				err('P2', `produces[${i}].from`, `${f} is not a declared permission`)
		}),
	)
	for (const id of permIds)
		if (!used.has(id) && id !== BACKGROUND_PERMISSION)
			err(
				'P3',
				'permissions',
				`${id} is declared but no data kind is produced from it (declare only what is used)`,
			)
	m.produces.forEach((d, i) => {
		for (const x of dup(d.fields.map((f) => f.name)))
			err('P1', `produces[${i}].fields`, `duplicate field ${x}`)
		d.fields.forEach((f, j) => {
			if (BAD_FIELD.test(f.name))
				err(
					'P4',
					`produces[${i}].fields[${j}]`,
					`field name ${f.name} looks like content (key, title, url, path, position, image...) and is refused`,
				)
		})
	})
	const qids = m.contributes.endpoint.queries.map((q) => q.id)
	for (const d of dup(qids)) err('P1', 'contributes.endpoint.queries', `duplicate query ${d}`)
	m.contributes.endpoint.queries.forEach((q, i) =>
		q.returns.forEach((r) => {
			if (!prodIds.includes(r))
				err('Q1', `contributes.endpoint.queries[${i}].returns`, `${r} is not in produces`)
		}),
	)
	for (const p of m.contributes.pages) {
		const q = p.source.counts.replace(/^query:/, '')
		if (!qids.includes(q))
			err('Q2', 'contributes.pages', `page reads query ${q}, which is not declared`)
	}
	for (const pl of m.platforms) {
		if (!m.entry.process.command[pl])
			err('E1', 'entry.process.command', `no command for declared platform ${pl}`)
		if (m.entry.maintenance && !m.entry.maintenance.command[pl])
			err('E1', 'entry.maintenance.command', `no maintenance command for ${pl}`)
	}
	for (const pl of Object.keys(m.entry.process.command))
		if (!m.platforms.includes(pl))
			err('E1', 'entry.process.command', `command for undeclared platform ${pl}`)
	for (const [k, v] of Object.entries(m.entry.process.env ?? {}))
		if (SECRETY.test(k) && !/^\$\{[a-zA-Z]+\}$/.test(v))
			err('E2', `entry.process.env.${k}`, 'a literal secret in the manifest is refused')
	;(m.contributes.settings ?? []).forEach((s, i) => {
		if (s.type === 'secret' && s.usedBy !== 'none')
			err('S1', `contributes.settings[${i}]`, 'phase 1: a secret may be used by nothing')
	})
	e.push(...crossRules2(m))
	return e
}

function depthOf(v: unknown, d = 0): number {
	if (d > MAX_DEPTH) return d
	if (Array.isArray(v)) return v.reduce<number>((a, x) => Math.max(a, depthOf(x, d + 1)), d)
	if (v && typeof v === 'object')
		return Object.values(v).reduce<number>((a, x) => Math.max(a, depthOf(x, d + 1)), d)
	return d
}

export type ParsedManifest =
	| { ok: true; manifest: Manifest }
	| { ok: false; issues: ManifestIssue[] }

/** Parse and fully validate the manifest bytes. Every failure names the rule, the path and the fix. */
export function parseManifest(bytes: Uint8Array | string): ParsedManifest {
	const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes)
	const fail = (rule: string, message: string): ParsedManifest => ({
		ok: false,
		issues: [{ rule, path: '', message }],
	})
	if (buf.length > MANIFEST_MAX_BYTES) return fail('V', 'the manifest is larger than 256 KiB')
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
	} catch {
		return fail('V', 'the manifest is not valid UTF-8')
	}
	if (text.charCodeAt(0) === 0xfeff)
		return fail('V', 'the manifest must not start with a byte order mark')
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))
		return fail('V', 'the manifest contains control characters')
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (error) {
		return fail('V', `the manifest is not valid JSON: ${(error as Error).message}`)
	}
	if (depthOf(raw) > MAX_DEPTH) return fail('V', 'the manifest is nested deeper than 12 levels')
	const w = new Walk()
	if (!w.isObj('', raw)) return { ok: false, issues: w.issues }
	w.keys(
		'',
		raw,
		[
			'manifestVersion',
			'id',
			'defaultLocale',
			'locales',
			'name',
			'description',
			'version',
			'publisher',
			'license',
			'engines',
			'platforms',
			'entry',
			'contributes',
			'permissions',
			'network',
			'files',
			'produces',
			'privacy',
			'legal',
			'licensing',
			'resources',
			'updates',
			'signing',
		],
		['$schema', 'ui', 'background'],
		RESERVED_TOP,
	)
	if (raw.manifestVersion !== 1) w.add('manifestVersion', 'must be 1')
	if (typeof raw.id === 'string' && raw.id.length <= 100 && !ID.test(raw.id))
		w.add('id', ID_REFUSAL)
	else w.str('id', raw.id, ID, 3, 100)
	w.str('defaultLocale', raw.defaultLocale, TAG, 1, 35)
	if (w.arr('locales', raw.locales, 1, 40)) {
		const seen = new Set<string>()
		raw.locales.forEach((l, i) => {
			w.str(`locales[${i}]`, l, TAG, 1, 35)
			if (seen.has(l as string)) w.add(`locales[${i}]`, 'listed twice')
			seen.add(l as string)
		})
	}
	w.text('name', raw.name, 1, 200)
	w.text('description', raw.description, 3, 900)
	w.str('version', raw.version, SEMVER)
	w.str('license', raw.license, undefined, 1, 80)
	if (raw.ui !== undefined) walkUi(w, raw.ui)
	if (raw.background !== undefined) walkBackground(w, raw.background)
	walkEntry(w, raw.entry)
	walkContributes(w, raw.contributes)
	walkPermissions(w, raw.permissions)
	walkProduces(w, raw.produces)
	walkPrivacyLegal(w, raw)
	walkRest(w, raw)
	if (w.issues.length > 0) return { ok: false, issues: w.issues }
	const manifest = raw as unknown as Manifest
	const cross = crossRules(manifest)
	if (cross.length > 0) return { ok: false, issues: cross }
	return { ok: true, manifest }
}

/** The text in the person's language: exact tag, then its language, then the package's default. */
export function pickLocale(
	text: Localized,
	wanted: string | undefined,
	defaultLocale: string,
): { text: string; locale: string } {
	const tryKeys = [wanted, wanted?.split('-')[0]].filter((k): k is string => !!k)
	for (const k of tryKeys) {
		const v = text[k]
		if (typeof v === 'string') return { text: v, locale: k }
	}
	return {
		text: text[defaultLocale] ?? Object.values(text)[0] ?? '',
		locale: defaultLocale,
	}
}

/** The language a person's own tag resolves to for this package: exact, language, default. */
export function resolveLocale(
	m: Pick<Manifest, 'locales' | 'defaultLocale'>,
	wanted: string | undefined,
): { locale: string; available: boolean } {
	if (!wanted) return { locale: m.defaultLocale, available: true }
	if (m.locales.includes(wanted)) return { locale: wanted, available: true }
	const lang = wanted.split('-')[0] ?? ''
	if (m.locales.includes(lang)) return { locale: lang, available: true }
	return { locale: m.defaultLocale, available: false }
}

/** Small range check for `engines`: `>=a.b.c <d.e.f`, `^`, `~`, `x`, `||`. */
export function satisfiesRange(version: string, range: string): boolean {
	const v = version.split('.').map((n) => Number.parseInt(n, 10))
	const cmp = (a: number[], b: number[]): number => {
		for (let i = 0; i < 3; i++) {
			const d = (a[i] ?? 0) - (b[i] ?? 0)
			if (d !== 0) return d
		}
		return 0
	}
	const parse = (s: string): number[] =>
		s.split('.').map((n) => (n === 'x' || n === '*' || n === '' ? 0 : Number.parseInt(n, 10)))
	return range.split('||').some((alt) =>
		alt
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.every((tok) => {
				const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(tok)
				if (!m) return false
				const op = m[1] ?? '='
				const want = parse(m[2] as string)
				switch (op) {
					case '>=':
						return cmp(v, want) >= 0
					case '<=':
						return cmp(v, want) <= 0
					case '>':
						return cmp(v, want) > 0
					case '<':
						return cmp(v, want) < 0
					case '=':
						return cmp(v, want) === 0
					case '^': {
						const hi = want[0]
							? [want[0] + 1, 0, 0]
							: want[1]
								? [0, (want[1] ?? 0) + 1, 0]
								: [0, 0, (want[2] ?? 0) + 1]
						return cmp(v, want) >= 0 && cmp(v, hi) < 0
					}
					default:
						return cmp(v, want) >= 0 && cmp(v, [want[0] ?? 0, (want[1] ?? 0) + 1, 0]) < 0
				}
			}),
	)
}
