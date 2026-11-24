/**
 * The `namzu-win/1` line codec: how this package talks to the native Windows
 * helper (`crates/namzu-win`), one JSON object per line over stdio.
 *
 * Only the codec lives here: a request is written with {@link encodeRequest},
 * a reply is read with {@link decodeReply}, which refuses a line that is not
 * the shape the op promises. The Rust side (`crates/namzu-win-core`) reads and
 * writes the same lines; `conformance/namzu-win/` is the list both are held to.
 */

import type {
	A11yAction,
	A11yChangeKind,
	A11yDisplay,
	A11yFingerprint,
	A11yNode,
	A11yRect,
	A11yWindow,
} from '../a11y/interface.js'

export const NATIVE_PROTOCOL = 'namzu-win/1'

/** The largest id or revision either side writes: a JavaScript number holds it exactly. */
export const MAX_SAFE_ID = Number.MAX_SAFE_INTEGER

export type NativeOp =
	| 'hello'
	| 'windows'
	| 'displays'
	| 'snapshot'
	| 'resolve'
	| 'seq'
	| 'wait_change'
	| 'cancel'
	| 'quit'

// --- requests ---------------------------------------------------------------

export type NativeRequest =
	| { readonly op: 'hello'; readonly protocol: string; readonly cliVersion: string }
	| { readonly op: 'windows'; readonly includeOwned?: boolean }
	| { readonly op: 'displays' }
	| {
			readonly op: 'snapshot'
			readonly windowId: string
			readonly maxNodes?: number
			readonly maxDepth?: number
			readonly skeleton?: boolean
			readonly allowChromium?: boolean
			readonly timeoutMs?: number
	  }
	| { readonly op: 'resolve'; readonly windowId: string; readonly fingerprint: A11yFingerprint }
	| { readonly op: 'seq'; readonly windowId?: string }
	| {
			readonly op: 'wait_change'
			readonly windowId: string
			readonly since?: number
			readonly quietMs?: number
			readonly timeoutMs?: number
			readonly kinds?: readonly A11yChangeKind[]
	  }
	| { readonly op: 'cancel'; readonly target: number }
	| { readonly op: 'quit' }

/** One request as a line, without the trailing newline. */
export function encodeRequest(id: number, request: NativeRequest): string {
	assertId(id)
	return JSON.stringify({ id, ...request })
}

// --- replies ----------------------------------------------------------------

export interface NativeHello {
	readonly version: string
	readonly buildHash: string
	readonly arch: string
	readonly osBuild: string
	readonly signer?: string
	readonly caps: readonly string[]
	readonly dpiAwareness: string
}

/** A control as the helper lists it: the accessibility node plus the ref `act` takes. */
export interface NativeNode extends A11yNode {
	readonly ref: string
}

export interface NativeSnapshot {
	readonly windowId: string
	readonly revision: number
	readonly nodes: readonly NativeNode[]
	readonly total: number
	readonly truncated: boolean
	readonly skeleton: boolean
	readonly readMs: number
}

export type NativeResolution =
	| {
			readonly found: true
			readonly index: number
			readonly via: 'runtimeId' | 'automationId' | 'name'
			readonly revision: number
	  }
	| {
			readonly found: false
			readonly code: 'not_found' | 'ambiguous'
			readonly candidates?: number
	  }

export type NativeWaitResult =
	| {
			readonly changed: true
			readonly settled: boolean
			readonly firstEventMs: number
			readonly settledMs: number
			readonly events: number
			readonly newWindows: readonly string[]
	  }
	| { readonly changed: false; readonly timedOut: true; readonly settledMs: number }

export interface NativeReplyBodies {
	readonly hello: NativeHello
	readonly windows: { readonly windows: readonly A11yWindow[] }
	readonly displays: { readonly displays: readonly A11yDisplay[] }
	readonly snapshot: NativeSnapshot
	readonly resolve: NativeResolution
	readonly seq: { readonly seq: number }
	readonly wait_change: NativeWaitResult
	readonly cancel: Record<string, never>
	readonly quit: Record<string, never>
}

export type NativeReply<K extends NativeOp> =
	| { readonly id: number; readonly ok: true; readonly body: NativeReplyBodies[K] }
	| { readonly id: number; readonly ok: false; readonly code: string; readonly message: string }

/** A line the helper should not have sent: not JSON, or not the shape the op promises. */
export class NativeProtocolError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'NativeProtocolError'
	}
}

type Obj = Record<string, unknown>

function bad(path: string, want: string): never {
	throw new NativeProtocolError(`${path} must be ${want}`)
}

function assertId(id: number): void {
	if (!Number.isSafeInteger(id) || id < 0) {
		throw new NativeProtocolError(
			'id must be a non-negative integer a JavaScript number holds exactly',
		)
	}
}

function obj(v: unknown, path: string): Obj {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) bad(path, 'an object')
	return v as Obj
}

function str(o: Obj, key: string, path: string): string {
	const v = o[key]
	if (typeof v !== 'string') bad(`${path}.${key}`, 'a string')
	return v
}

function optStr(o: Obj, key: string, path: string): string | undefined {
	return o[key] === undefined ? undefined : str(o, key, path)
}

function int(o: Obj, key: string, path: string, min = 0): number {
	const v = o[key]
	if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) {
		bad(`${path}.${key}`, `an integer of at least ${min}`)
	}
	return v
}

function optInt(o: Obj, key: string, path: string): number | undefined {
	return o[key] === undefined ? undefined : int(o, key, path)
}

function num(o: Obj, key: string, path: string): number {
	const v = o[key]
	if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${path}.${key}`, 'a number')
	return v
}

function bool(o: Obj, key: string, path: string): boolean {
	const v = o[key]
	if (typeof v !== 'boolean') bad(`${path}.${key}`, 'a boolean')
	return v
}

function optBool(o: Obj, key: string, path: string): boolean | undefined {
	return o[key] === undefined ? undefined : bool(o, key, path)
}

function arr(o: Obj, key: string, path: string): readonly unknown[] {
	const v = o[key]
	if (!Array.isArray(v)) bad(`${path}.${key}`, 'a list')
	return v
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], path: string): T {
	if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
		bad(path, `one of ${allowed.join(', ')}`)
	}
	return v as T
}

function rect(o: Obj, key: string, path: string): A11yRect {
	const r = obj(o[key], `${path}.${key}`)
	const p = `${path}.${key}`
	return {
		x: int(r, 'x', p, Number.MIN_SAFE_INTEGER),
		y: int(r, 'y', p, Number.MIN_SAFE_INTEGER),
		width: int(r, 'width', p, Number.MIN_SAFE_INTEGER),
		height: int(r, 'height', p, Number.MIN_SAFE_INTEGER),
	}
}

const ACTIONS: readonly A11yAction[] = [
	'invoke',
	'value',
	'toggle',
	'expandCollapse',
	'selectionItem',
	'scroll',
]

function node(v: unknown, path: string): NativeNode {
	const o = obj(v, path)
	const out: { -readonly [K in keyof NativeNode]: NativeNode[K] } = {
		index: int(o, 'index', path),
		ref: str(o, 'ref', path),
		parent: int(o, 'parent', path, -1),
		depth: int(o, 'depth', path),
		role: str(o, 'role', path),
		bounds: rect(o, 'bounds', path),
		enabled: bool(o, 'enabled', path),
		offscreen: bool(o, 'offscreen', path),
		focused: bool(o, 'focused', path),
		actions: arr(o, 'actions', path).map((a, i) => oneOf(a, ACTIONS, `${path}.actions[${i}]`)),
	}
	const name = optStr(o, 'name', path)
	if (name !== undefined) out.name = name
	const automationId = optStr(o, 'automationId', path)
	if (automationId !== undefined) out.automationId = automationId
	const className = optStr(o, 'className', path)
	if (className !== undefined) out.className = className
	const value = optStr(o, 'value', path)
	if (value !== undefined) out.value = value
	if (o.toggle !== undefined)
		out.toggle = oneOf<'on' | 'off' | 'mixed'>(o.toggle, ['on', 'off', 'mixed'], `${path}.toggle`)
	if (o.expand !== undefined) {
		out.expand = oneOf<'expanded' | 'collapsed' | 'partial' | 'leaf'>(
			o.expand,
			['expanded', 'collapsed', 'partial', 'leaf'],
			`${path}.expand`,
		)
	}
	const selected = optBool(o, 'selected', path)
	if (selected !== undefined) out.selected = selected
	const childCount = optInt(o, 'childCount', path)
	if (childCount !== undefined) out.childCount = childCount
	return out
}

function window(v: unknown, path: string): A11yWindow {
	const o = obj(v, path)
	return {
		windowId: str(o, 'windowId', path),
		processId: int(o, 'processId', path),
		processName: str(o, 'processName', path),
		title: str(o, 'title', path),
		bounds: rect(o, 'bounds', path),
		minimized: bool(o, 'minimized', path),
		focused: bool(o, 'focused', path),
		z: int(o, 'z', path),
	}
}

function display(v: unknown, path: string): A11yDisplay {
	const o = obj(v, path)
	return {
		id: str(o, 'id', path),
		bounds: rect(o, 'bounds', path),
		workArea: rect(o, 'workArea', path),
		scale: num(o, 'scale', path),
		primary: bool(o, 'primary', path),
	}
}

function hello(o: Obj): NativeHello {
	const out: { -readonly [K in keyof NativeHello]: NativeHello[K] } = {
		version: str(o, 'version', 'hello'),
		buildHash: str(o, 'buildHash', 'hello'),
		arch: str(o, 'arch', 'hello'),
		osBuild: str(o, 'osBuild', 'hello'),
		caps: arr(o, 'caps', 'hello').map((c, i) => {
			if (typeof c !== 'string') bad(`hello.caps[${i}]`, 'a string')
			return c
		}),
		dpiAwareness: str(o, 'dpiAwareness', 'hello'),
	}
	const signer = optStr(o, 'signer', 'hello')
	if (signer !== undefined) out.signer = signer
	return out
}

function snapshot(o: Obj): NativeSnapshot {
	return {
		windowId: str(o, 'windowId', 'snapshot'),
		revision: int(o, 'revision', 'snapshot'),
		nodes: arr(o, 'nodes', 'snapshot').map((n, i) => node(n, `snapshot.nodes[${i}]`)),
		total: int(o, 'total', 'snapshot'),
		truncated: bool(o, 'truncated', 'snapshot'),
		skeleton: bool(o, 'skeleton', 'snapshot'),
		readMs: num(o, 'readMs', 'snapshot'),
	}
}

function resolution(o: Obj): NativeResolution {
	if (bool(o, 'found', 'resolve')) {
		return {
			found: true,
			index: int(o, 'index', 'resolve'),
			via: oneOf(o.via, ['runtimeId', 'automationId', 'name'], 'resolve.via'),
			revision: int(o, 'revision', 'resolve'),
		}
	}
	const code = oneOf(o.code, ['not_found', 'ambiguous'], 'resolve.code')
	const candidates = optInt(o, 'candidates', 'resolve')
	return candidates === undefined ? { found: false, code } : { found: false, code, candidates }
}

function waitResult(o: Obj): NativeWaitResult {
	if (bool(o, 'changed', 'wait_change')) {
		return {
			changed: true,
			settled: bool(o, 'settled', 'wait_change'),
			firstEventMs: int(o, 'firstEventMs', 'wait_change', Number.MIN_SAFE_INTEGER),
			settledMs: int(o, 'settledMs', 'wait_change'),
			events: int(o, 'events', 'wait_change'),
			newWindows: arr(o, 'newWindows', 'wait_change').map((w, i) => {
				if (typeof w !== 'string') bad(`wait_change.newWindows[${i}]`, 'a string')
				return w
			}),
		}
	}
	if (o.timedOut !== true) bad('wait_change.timedOut', 'true when nothing changed')
	return { changed: false, timedOut: true, settledMs: int(o, 'settledMs', 'wait_change') }
}

function body(op: NativeOp, o: Obj): NativeReplyBodies[NativeOp] {
	switch (op) {
		case 'hello':
			return hello(o)
		case 'windows':
			return { windows: arr(o, 'windows', 'windows').map((w, i) => window(w, `windows[${i}]`)) }
		case 'displays':
			return {
				displays: arr(o, 'displays', 'displays').map((d, i) => display(d, `displays[${i}]`)),
			}
		case 'snapshot':
			return snapshot(o)
		case 'resolve':
			return resolution(o)
		case 'seq':
			return { seq: int(o, 'seq', 'seq') }
		case 'wait_change':
			return waitResult(o)
		case 'cancel':
		case 'quit':
			return {}
	}
}

/**
 * Reads the reply to a request of kind `op`. Throws {@link NativeProtocolError}
 * for a line that is not a reply; a reply that says the request failed is a
 * value (`ok: false`), not a throw.
 */
export function decodeReply<K extends NativeOp>(op: K, line: string): NativeReply<K> {
	let parsed: unknown
	try {
		parsed = JSON.parse(line)
	} catch {
		throw new NativeProtocolError('a reply is one JSON object per line')
	}
	const o = obj(parsed, 'reply')
	const id = int(o, 'id', 'reply')
	if (typeof o.ok !== 'boolean') bad('reply.ok', 'a boolean')
	if (!o.ok) {
		return { id, ok: false, code: str(o, 'code', 'reply'), message: str(o, 'message', 'reply') }
	}
	return { id, ok: true, body: body(op, o) as NativeReplyBodies[K] }
}

// --- refs -------------------------------------------------------------------

/** A ref names control `index` of read `revision`: `r<revision>.<index>`. */
export function formatRef(revision: number, index: number): string {
	return `r${revision}.${index}`
}

const MAX_INDEX = 0xffff_ffff

function plainNumber(s: string, max: number): number | undefined {
	if (!/^(0|[1-9][0-9]*)$/.test(s)) return undefined
	const n = Number(s)
	return Number.isSafeInteger(n) && n <= max ? n : undefined
}

/** The pair a ref names, or `undefined` for a string that is not exactly one. */
export function parseRef(ref: string): { revision: number; index: number } | undefined {
	const m = /^r([0-9]+)\.([0-9]+)$/.exec(ref)
	if (!m) return undefined
	const revision = plainNumber(m[1] ?? '', MAX_SAFE_ID)
	const index = plainNumber(m[2] ?? '', MAX_INDEX)
	return revision === undefined || index === undefined ? undefined : { revision, index }
}

// --- fingerprints -----------------------------------------------------------

/**
 * FNV-1a 32 over the UTF-16 code units of `s`, eight lowercase hex digits:
 * the `nameHash` of a fingerprint, the same as the PowerShell helper wrote.
 */
export function nameHash(s: string): string {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 16777619) >>> 0
	}
	return h.toString(16).padStart(8, '0')
}
