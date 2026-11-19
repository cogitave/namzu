import {
	type BridgeBackend,
	type HostMethod,
	OPEN_NAMZU_TARGETS,
	type OpenTarget,
} from './bridge.js'
import type { PageInfo } from './registry.js'
import type { Bounds, PageSpec } from './view.js'

/**
 * What the main process does for extension pages, apart from Electron: ask the engine what to draw, turn a
 * bridge call into the engine's own query or action (which checks params and answer against the manifest),
 * and answer the host helpers. Everything the engine says about a page comes back through `ui`.
 */

export interface UiInfo {
	version: string
	dir: string
	accent: string
	icon: string
	pages: {
		id: string
		title: string
		slot: string
		entry: string
		minHeight?: number
		usesNetwork: boolean
		bridge: { allow: string[]; host: string[] }
		hosts: string[]
	}[]
	chips: { id: string; state: string; label: string; tone: string; icon?: string; opens?: string }[]
	files: { path: string; sha256: string }[]
	methods: { method: string; maxBytes: number }[]
}

export type EngineCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** The engine answers a refusal the person can read as `{ error: { code, check, message } }`. */
export class EngineRefusal extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

/** Read what `namzu/extensions/ui` answered, or nothing when it is not a well-formed answer. */
export function readUiInfo(value: unknown): UiInfo | undefined {
	const ui = rec(rec(value)?.ui)
	if (!ui || typeof ui.dir !== 'string' || !Array.isArray(ui.pages) || !Array.isArray(ui.files))
		return undefined
	const str = (v: unknown, max = 300): string | undefined =>
		typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
	const pages: UiInfo['pages'] = []
	for (const p of ui.pages.slice(0, 6)) {
		const r = rec(p)
		const b = rec(r?.bridge)
		const id = str(r?.id, 48)
		const entry = str(r?.entry, 200)
		if (!r || !b || !id || !entry || !Array.isArray(b.allow)) continue
		pages.push({
			id,
			title: str(r.title, 200) ?? id,
			slot: str(r.slot, 20) ?? 'settings',
			entry,
			...(typeof r.minHeight === 'number' ? { minHeight: r.minHeight } : {}),
			usesNetwork: r.usesNetwork === true,
			bridge: {
				allow: b.allow.filter((x): x is string => typeof x === 'string').slice(0, 24),
				host: (Array.isArray(b.host) ? b.host : []).filter(
					(x): x is string => typeof x === 'string',
				),
			},
			hosts: (Array.isArray(r.hosts) ? r.hosts : [])
				.filter((x): x is string => typeof x === 'string')
				.slice(0, 8),
		})
	}
	const files: UiInfo['files'] = []
	for (const f of ui.files.slice(0, 2000)) {
		const r = rec(f)
		if (r && str(r.path, 300) && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256))
			files.push({ path: r.path as string, sha256: r.sha256 })
	}
	const chips: UiInfo['chips'] = []
	for (const c of Array.isArray(ui.chips) ? ui.chips.slice(0, 2) : []) {
		const r = rec(c)
		if (r && str(r.id, 48) && str(r.state, 24) && str(r.label, 80) && str(r.tone, 8))
			chips.push({
				id: r.id as string,
				state: r.state as string,
				label: r.label as string,
				tone: r.tone as string,
				...(str(r.icon, 200) ? { icon: r.icon as string } : {}),
				...(str(r.opens, 48) ? { opens: r.opens as string } : {}),
			})
	}
	const methods: UiInfo['methods'] = []
	for (const m of Array.isArray(ui.methods) ? ui.methods.slice(0, 48) : []) {
		const r = rec(m)
		if (r && str(r.method, 80) && typeof r.maxBytes === 'number')
			methods.push({ method: r.method as string, maxBytes: r.maxBytes })
	}
	return {
		version: str(ui.version, 40) ?? '',
		dir: ui.dir,
		accent: str(ui.accent, 9) ?? '#808080',
		icon: str(ui.icon, 200) ?? '',
		pages,
		chips,
		files,
		methods,
	}
}

/** The page's spec for the view: only what the manifest declares, with the size each answer may have. */
export function pageSpec(extensionId: string, info: UiInfo, pageId: string): PageSpec | undefined {
	const p = info.pages.find((x) => x.id === pageId)
	if (!p) return undefined
	const maxBytes: Record<string, number> = {}
	for (const m of info.methods) maxBytes[m.method] = m.maxBytes
	return {
		extensionId,
		pageId,
		entry: p.entry,
		slot: p.slot,
		...(p.minHeight ? { minHeight: p.minHeight } : {}),
		usesNetwork: p.usesNetwork,
		hosts: p.hosts,
		allow: p.bridge.allow,
		host: p.bridge.host.filter((h): h is HostMethod =>
			['theme', 'locale', 'state', 'openNamzu'].includes(h),
		),
		maxBytes,
	}
}

/** The states a page may be told about; every other state of the engine reads as `stopped`. */
const PAGE_STATES = [
	'running',
	'stopped',
	'starting',
	'not-responding',
	'failed',
	'license-grace',
	'license-expired',
	'license-revoked',
	'needs-notice',
] as const
export const pageState = (state: unknown): (typeof PAGE_STATES)[number] =>
	(PAGE_STATES as readonly unknown[]).includes(state)
		? (state as (typeof PAGE_STATES)[number])
		: 'stopped'

export interface BackendDeps {
	readonly engine: EngineCall
	/** The tokens for one extension's pages: Namzu's own, and that extension's accent. */
	readonly theme: (extensionId: string) => { dark: boolean; tokens: Record<string, string> }
	readonly locale: () => string
	/** The engine's last state word for this extension, kept from its state events. */
	readonly state: (extensionId: string) => unknown
	readonly openNamzu: (info: PageInfo, target: OpenTarget) => void
}

/** The bridge backend of one page: the engine call for a declared method, and the host helpers. */
export function pageBackend(d: BackendDeps, info: PageInfo): BridgeBackend {
	return {
		async extension(method, params, activation) {
			const sep = method.indexOf(':')
			const kind = method.slice(0, sep)
			const id = method.slice(sep + 1)
			const answer = await (kind === 'query'
				? d.engine('namzu/extensions/query', { id: info.extensionId, query: id, params })
				: d.engine('namzu/extensions/action', {
						id: info.extensionId,
						action: id,
						params,
						activation,
					}))
			// The engine says a refusal as `{ error }`; anything else is the answer, already checked.
			const error = rec(rec(answer)?.error)
			if (error)
				throw new EngineRefusal(String(error.code ?? 'unavailable'), String(error.message ?? ''))
			return answer ?? null
		},
		theme: () => d.theme(info.extensionId),
		locale: () => ({ locale: d.locale() }),
		state: () => ({ state: pageState(d.state(info.extensionId)) }),
		openNamzu: (target) => {
			if ((OPEN_NAMZU_TARGETS as readonly string[]).includes(target)) d.openNamzu(info, target)
		},
	}
}

export type { Bounds }
