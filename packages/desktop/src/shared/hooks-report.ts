/**
 * What runs by itself in a folder, as the engine answers it (`namzu/hooks/list`, `namzu hooks --json`).
 *
 * The types below mirror `packages/cli/src/config/hooks-report.ts`; the desktop contract test checks
 * that file's shapes by digest, so a change there is noticed here. The reader is deliberately
 * tolerant and deliberately narrow: it copies only the fields it knows, so a header, an environment
 * value or any field a newer engine adds never reaches the screen, and it never invents a hook.
 */

export const HOOKS_REPORT_VERSION = 1

export type HookOriginKind = 'config' | 'plugin' | 'skill' | 'agent'
export type HookState = 'runs' | 'off' | 'attaches-when-used' | 'not-loaded'
export type HookType = 'command' | 'http' | 'prompt'

export interface HookOrigin {
	kind: HookOriginKind
	label: string
	name?: string
	path?: string
	scope?: string
}

export interface HookWhy {
	/** A reason code; one this app does not know is shown by its text alone. */
	code: string
	text: string
}

export interface HookRow {
	id: string
	event: string
	eventWritten?: string
	matcher?: string
	condition?: string
	type: HookType
	runs: string
	origin: HookOrigin
	state: HookState
	why?: HookWhy
	once?: boolean
	async?: boolean
	timeoutMs?: number
	onFailure?: string
	notes?: string[]
}

export interface HookModuleRow {
	plugin: string
	module: string
	origin: HookOrigin
	state: HookState
	why?: HookWhy
}

export interface HookProblem {
	severity: 'problem' | 'note'
	origin: HookOrigin
	event?: string
	file?: string
	message: string
	inactive?: 'folder-not-trusted'
}

export interface SwitchSource {
	/** `default`, `user-file`, `project-file`, `local-file`, `profile`, `env`, `managed`; others are kept as written. */
	kind: string
	path?: string
	variable?: string
	profile?: string
}

export interface SwitchReport {
	on: boolean
	setBy?: SwitchSource
}

export interface HooksReport {
	version: number
	folder: { path: string; trusted: boolean }
	switches: {
		disableHooks: SwitchReport
		hooksManagedOnly: SwitchReport
		plugins: SwitchReport
		limiting?: 'disabled' | 'managed-only'
	}
	hooks: HookRow[]
	modules: HookModuleRow[]
	problems: HookProblem[]
	counts: {
		runs: number
		off: number
		attachesWhenUsed: number
		notLoaded: number
		waitingForTrust: number
		problems: number
	}
	error?: string
	/** Entries of the answer this reader could not make sense of; they are counted, never dropped silently. */
	unreadable?: number
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

/** One line of plain text: control characters out, whitespace flattened, bounded. */
export function plainText(value: unknown, max: number): string | undefined {
	if (typeof value !== 'string') return undefined
	const flat = value
		.replace(/\p{Cc}+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
	if (!flat) return undefined
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * What a command line, an address or a prompt line looks like on screen. The engine already leaves
 * out credentials and queries; this removes them again so a view never depends on that alone:
 * userinfo and queries of addresses, and the value of anything that looks like `NAME=value` for a
 * name that reads as a secret.
 */
export function safeRuns(text: string): string {
	return text
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1')
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi, '$1')
		.replace(
			/(--?[\w-]*(?:token|secret|password|passwd|apikey|api[-_]key|auth|bearer|credential)[\w-]*[=:]|\b[\w.-]*(?:token|secret|password|passwd|apikey|api[-_]key|auth|bearer|credential)[\w.-]*=)(\S+)/gi,
			'$1…',
		)
		.replace(/(\b(?:bearer|token|authorization)\s+)\S+/gi, '$1…')
}

const STATES: readonly HookState[] = ['runs', 'off', 'attaches-when-used', 'not-loaded']
const KINDS: readonly HookOriginKind[] = ['config', 'plugin', 'skill', 'agent']
const TYPES: readonly HookType[] = ['command', 'http', 'prompt']

function readOrigin(value: unknown): HookOrigin | undefined {
	const o = record(value)
	if (!o || !KINDS.includes(o.kind as HookOriginKind)) return undefined
	const label = plainText(o.label, 400)
	if (!label) return undefined
	const name = plainText(o.name, 200)
	const path = plainText(o.path, 600)
	const scope = plainText(o.scope, 40)
	return {
		kind: o.kind as HookOriginKind,
		label,
		...(name ? { name } : {}),
		...(path ? { path } : {}),
		...(scope ? { scope } : {}),
	}
}

function readWhy(value: unknown): HookWhy | undefined {
	const w = record(value)
	if (!w) return undefined
	const text = plainText(w.text, 500)
	const code = plainText(w.code, 60)
	return text ? { code: code ?? '', text } : undefined
}

/**
 * A state this app does not know is kept as `not-loaded` when the engine said nothing runs, which is
 * the cautious reading of an unexplained "not now"; it is never promoted to `runs`.
 */
function readState(value: unknown): HookState {
	return STATES.includes(value as HookState) ? (value as HookState) : 'not-loaded'
}

function readRow(value: unknown): HookRow | undefined {
	const r = record(value)
	if (!r) return undefined
	const origin = readOrigin(r.origin)
	const event = plainText(r.event, 80)
	const id = plainText(r.id, 80)
	const runs = typeof r.runs === 'string' ? safeRuns(plainText(r.runs, 400) ?? '') : ''
	if (!origin || !event || !id) return undefined
	const eventWritten = plainText(r.eventWritten, 80)
	const matcher = plainText(r.matcher, 300)
	const condition = plainText(r.condition, 300)
	const why = readWhy(r.why)
	const onFailure = plainText(r.onFailure, 40)
	const notes = Array.isArray(r.notes)
		? r.notes.flatMap((note) => {
				const text = plainText(note, 400)
				return text ? [text] : []
			})
		: []
	return {
		id,
		event,
		...(eventWritten ? { eventWritten } : {}),
		...(matcher ? { matcher } : {}),
		...(condition ? { condition } : {}),
		type: TYPES.includes(r.type as HookType) ? (r.type as HookType) : 'command',
		runs,
		origin,
		state: readState(r.state),
		...(why ? { why } : {}),
		...(r.once === true ? { once: true } : {}),
		...(r.async === true ? { async: true } : {}),
		...(typeof r.timeoutMs === 'number' && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0
			? { timeoutMs: r.timeoutMs }
			: {}),
		...(onFailure ? { onFailure } : {}),
		...(notes.length > 0 ? { notes: notes.slice(0, 8) } : {}),
	}
}

function readModule(value: unknown): HookModuleRow | undefined {
	const m = record(value)
	if (!m) return undefined
	const origin = readOrigin(m.origin)
	const plugin = plainText(m.plugin, 200)
	const module = plainText(m.module, 400)
	if (!origin || !plugin || !module) return undefined
	const why = readWhy(m.why)
	return { plugin, module, origin, state: readState(m.state), ...(why ? { why } : {}) }
}

function readProblem(value: unknown): HookProblem | undefined {
	const p = record(value)
	if (!p) return undefined
	const origin = readOrigin(p.origin)
	const message = plainText(p.message, 600)
	if (!origin || !message) return undefined
	const event = plainText(p.event, 80)
	const file = plainText(p.file, 400)
	return {
		severity: p.severity === 'problem' ? 'problem' : 'note',
		origin,
		...(event ? { event } : {}),
		...(file ? { file } : {}),
		message,
		...(p.inactive === 'folder-not-trusted' ? { inactive: 'folder-not-trusted' as const } : {}),
	}
}

function readSwitch(value: unknown): SwitchReport {
	const s = record(value)
	const by = record(s?.setBy)
	const kind = plainText(by?.kind, 40)
	const path = plainText(by?.path, 600)
	const variable = plainText(by?.variable, 80)
	const profile = plainText(by?.profile, 120)
	return {
		on: s?.on === true,
		...(kind
			? {
					setBy: {
						kind,
						...(path ? { path } : {}),
						...(variable ? { variable } : {}),
						...(profile ? { profile } : {}),
					},
				}
			: {}),
	}
}

const count = (value: unknown): number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0

/**
 * Reads the engine's answer, or returns nothing when it is not one. A row it cannot read is counted
 * in `unreadable`, so the screen can say that something was left out instead of looking complete.
 */
export function readHooksReport(value: unknown): HooksReport | undefined {
	const root = record(value)
	if (!root || typeof root.version !== 'number' || !Array.isArray(root.hooks)) return undefined
	const folder = record(root.folder)
	const switches = record(root.switches)
	const counts = record(root.counts)
	const hooks: HookRow[] = []
	const modules: HookModuleRow[] = []
	const problems: HookProblem[] = []
	let unreadable = 0
	const each = <T>(list: unknown, read: (item: unknown) => T | undefined, into: T[]) => {
		if (!Array.isArray(list)) return
		for (const item of list.slice(0, 2000)) {
			const row = read(item)
			if (row) into.push(row)
			else unreadable++
		}
		if (list.length > 2000) unreadable += list.length - 2000
	}
	each(root.hooks, readRow, hooks)
	each(root.modules, readModule, modules)
	each(root.problems, readProblem, problems)
	const limiting =
		switches?.limiting === 'disabled' || switches?.limiting === 'managed-only'
			? switches.limiting
			: undefined
	const error = plainText(root.error, 400)
	return {
		version: root.version,
		folder: {
			path: plainText(folder?.path, 800) ?? '',
			trusted: folder?.trusted === true,
		},
		switches: {
			disableHooks: readSwitch(switches?.disableHooks),
			hooksManagedOnly: readSwitch(switches?.hooksManagedOnly),
			plugins: readSwitch(switches?.plugins),
			...(limiting ? { limiting } : {}),
		},
		hooks,
		modules,
		problems,
		counts: {
			runs: count(counts?.runs),
			off: count(counts?.off),
			attachesWhenUsed: count(counts?.attachesWhenUsed),
			notLoaded: count(counts?.notLoaded),
			waitingForTrust: count(counts?.waitingForTrust),
			problems: count(counts?.problems),
		},
		...(error ? { error } : {}),
		...(unreadable > 0 ? { unreadable } : {}),
	}
}
