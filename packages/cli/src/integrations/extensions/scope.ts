import { canon, sha256Hex } from './canon.js'
import { localizedTexts } from './manifest.js'
import type { Manifest } from './types.js'

/** What a person acknowledges: ids and numbers only, no wording. */
export interface Scope {
	v: 1
	id: string
	noticeVersion: string
	permissions: { id: string; optional: boolean; purposes: string[] }[]
	produces: {
		id: string
		from: string[]
		fields: string[]
		retentionDays: number
		leavesMachine: boolean
	}[]
	files: { path: string; access: string }[]
	network: string
	/** Declared hosts with what each is for (empty when the network mode is none). */
	hosts: { host: string; for: string[] }[]
	/** The licence: its kind, and for a service the host and every field the check sends. */
	licence: { kind: string; host?: string; sends?: string[] }
	/** Where the extension runs while Namzu is closed: nothing, or sign-in with its own tray mark or none. */
	background: { runAt: string; indicator: string } | null
	/** True when any extension page may use the network. */
	pagesUseNetwork: boolean
	leavesTheMachine: string
	monitoringKind: string
	adminCanRead: boolean
	runsAtLogin: boolean
}

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id)

export function scopeOf(m: Manifest): Scope {
	return {
		v: 1,
		id: m.id,
		noticeVersion: m.legal.noticeVersion,
		permissions: m.permissions
			.map((p) => ({
				id: p.id,
				optional: p.optional,
				purposes: p.purposes.map((u) => u.id).sort(),
			}))
			.sort(byId),
		produces: m.produces
			.map((d) => ({
				id: d.id,
				from: [...d.from].sort(),
				fields: d.fields.map((f) => f.name).sort(),
				retentionDays: d.retentionDays,
				leavesMachine: d.leavesMachine,
			}))
			.sort(byId),
		files: m.files
			.map((f) => ({ path: f.path, access: f.access }))
			.sort((a, b) => a.path.localeCompare(b.path)),
		network: m.network.mode,
		hosts:
			m.network.mode === 'declared'
				? m.network.hosts
						.map((h) => ({ host: h.host, for: [...h.for].sort() }))
						.sort((a, b) => a.host.localeCompare(b.host))
				: [],
		licence: licenceScope(m),
		background: m.background
			? { runAt: m.background.runAt, indicator: m.background.indicator.kind }
			: null,
		pagesUseNetwork: (m.ui?.pages ?? []).some((p) => p.usesNetwork === true),
		leavesTheMachine: m.privacy.leavesTheMachine,
		monitoringKind: m.privacy.monitoringKind,
		adminCanRead: m.privacy.storage.adminCanRead,
		runsAtLogin: m.background !== undefined,
	}
}

function licenceScope(m: Manifest): Scope['licence'] {
	const l = m.licensing
	if (l.kind !== 'service') return { kind: l.kind }
	return {
		kind: 'service',
		host: /^https:\/\/([^/]+)/.exec(l.service.baseUrl)?.[1] ?? '',
		sends: [...l.service.sends].sort(),
	}
}

export const scopeHash = (s: Scope): string => sha256Hex(canon(s))

/** The default-locale words a person read plus the default notice hash; a change under one notice version is refused. */
export function wordingDigest(m: Manifest): string {
	const d = m.defaultLocale
	const texts = localizedTexts(m)
		.map(([p, t]) => [p, t[d]] as const)
		.sort((a, b) => a[0].localeCompare(b[0]))
	return sha256Hex(
		canon({
			texts,
			notice: m.legal.notices[d]?.sha256,
			noticeVersion: m.legal.noticeVersion,
		}),
	)
}

/** Why the person must be asked again. Empty means the same or narrower scope: never ask. */
export function widerReasons(o: Scope, n: Scope): string[] {
	const r: string[] = []
	if (n.noticeVersion !== o.noticeVersion)
		r.push(`notice version ${o.noticeVersion} -> ${n.noticeVersion}`)
	const om = new Map(o.permissions.map((p) => [p.id, p]))
	for (const p of n.permissions) {
		const q = om.get(p.id)
		if (!q) {
			r.push(`new permission ${p.id}`)
			continue
		}
		for (const u of p.purposes) if (!q.purposes.includes(u)) r.push(`new purpose ${u} on ${p.id}`)
		if (q.optional && !p.optional) r.push(`${p.id} is no longer optional`)
	}
	const od = new Map(o.produces.map((d) => [d.id, d]))
	for (const d of n.produces) {
		const q = od.get(d.id)
		if (!q) {
			r.push(`new data kind ${d.id}`)
			continue
		}
		for (const f of d.fields) if (!q.fields.includes(f)) r.push(`new field ${f} in ${d.id}`)
		for (const f of d.from) if (!q.from.includes(f)) r.push(`${d.id} now also reads ${f}`)
		if (d.retentionDays > q.retentionDays)
			r.push(`longer retention for ${d.id}: ${q.retentionDays} -> ${d.retentionDays}`)
		if (d.leavesMachine && !q.leavesMachine) r.push(`${d.id} now leaves the machine`)
	}
	const of = new Set(o.files.map((f) => f.path + f.access))
	for (const f of n.files) if (!of.has(f.path + f.access)) r.push(`new file access ${f.path}`)
	if (o.network !== n.network) r.push(`network ${o.network} -> ${n.network}`)
	const oh = new Map(o.hosts.map((h) => [h.host, h.for]))
	for (const h of n.hosts) {
		const was = oh.get(h.host)
		if (!was) r.push(`new network host ${h.host}`)
		else for (const u of h.for) if (!was.includes(u)) r.push(`${h.host} is now also used for ${u}`)
	}
	if (n.licence.kind === 'service') {
		if (o.licence.kind !== 'service' || o.licence.host !== n.licence.host)
			r.push(`the licence check now contacts ${n.licence.host}`)
		else
			for (const f of n.licence.sends ?? [])
				if (!(o.licence.sends ?? []).includes(f)) r.push(`the licence check now also sends ${f}`)
	}
	if (!o.pagesUseNetwork && n.pagesUseNetwork) r.push('an extension page can now use the network')
	if (!o.background && n.background)
		r.push('now starts when you sign in and keeps running when Namzu is closed')
	if (
		o.background &&
		n.background &&
		o.background.indicator === 'tray' &&
		n.background.indicator !== 'tray'
	)
		r.push('its own indicator while Namzu is closed was removed')
	if (o.leavesTheMachine !== n.leavesTheMachine) r.push('what leaves the machine changed')
	if (o.monitoringKind !== n.monitoringKind) r.push('kind of monitoring changed')
	if (!o.adminCanRead && n.adminCanRead) r.push('an administrator can now read the data')
	return r
}
