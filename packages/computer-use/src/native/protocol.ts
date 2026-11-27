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
	| 'identity'
	| 'resolve'
	| 'seq'
	| 'wait_change'
	| 'act'
	| 'input'
	| 'capture'
	| 'foreground.get'
	| 'foreground.set'
	| 'lease.begin'
	| 'lease.end'
	| 'monitor.start'
	| 'monitor.stop'
	| 'monitor.poll'
	| 'watch.start'
	| 'watch.stop'
	| 'watch.poll'
	| 'presence.act'
	| 'presence.hide'
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
	| {
			readonly op: 'identity'
			readonly windowId: string
			readonly index: number
			readonly revision?: number
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
	| NativeActRequest
	| NativeInputRequest
	| NativeCaptureRequest
	| { readonly op: 'foreground.get'; readonly windowId?: string; readonly processId?: number }
	| { readonly op: 'foreground.set'; readonly windowId: string }
	| NativeLeaseBeginRequest
	| {
			readonly op: 'lease.end'
			readonly restore: boolean
			readonly keepCursor?: boolean
			readonly release?: boolean
	  }
	| NativeMonitorStartRequest
	| { readonly op: 'monitor.stop' }
	| { readonly op: 'monitor.poll'; readonly since?: number }
	| NativeWatchStartRequest
	| { readonly op: 'watch.stop' }
	| { readonly op: 'watch.poll' }
	| NativePresenceActRequest
	| { readonly op: 'presence.hide' }
	| { readonly op: 'cancel'; readonly target: number }
	| { readonly op: 'quit' }

/** What `act` does to a control, through the pattern it offers. */
export type NativeActKind =
	| 'invoke'
	| 'setValue'
	| 'toggle'
	| 'expand'
	| 'collapse'
	| 'select'
	| 'scrollIntoView'
	| 'scroll'
	| 'focus'

/** One of `ref` and `fingerprint` names the control. */
export interface NativeActRequest {
	readonly op: 'act'
	readonly windowId: string
	readonly ref?: string
	readonly fingerprint?: A11yFingerprint
	readonly action: NativeActKind
	/** For `setValue`. */
	readonly text?: string
	/** For `scroll`: steps right and down are positive. */
	readonly dx?: number
	readonly dy?: number
	readonly timeoutMs?: number
}

export type NativeMouseButton = 'left' | 'right' | 'middle'
export type NativeScrollDirection = 'up' | 'down' | 'left' | 'right'

/** Points are virtual-desktop physical pixels. */
export type NativeInputRequest = { readonly op: 'input' } & (
	| {
			readonly kind: 'click'
			readonly x: number
			readonly y: number
			readonly button?: NativeMouseButton
			readonly count?: 1 | 2 | 3
	  }
	| { readonly kind: 'move'; readonly x: number; readonly y: number }
	| {
			readonly kind: 'drag'
			readonly x: number
			readonly y: number
			readonly toX: number
			readonly toY: number
			readonly button?: NativeMouseButton
	  }
	| {
			readonly kind: 'scroll'
			readonly x: number
			readonly y: number
			readonly direction: NativeScrollDirection
			readonly amount?: number
	  }
	| { readonly kind: 'type'; readonly text: string }
	| { readonly kind: 'key'; readonly keys: string }
)

export type NativeCaptureTarget =
	| { readonly kind: 'window'; readonly windowId: string }
	| { readonly kind: 'display'; readonly id?: string }
	| {
			readonly kind: 'region'
			readonly x: number
			readonly y: number
			readonly width: number
			readonly height: number
	  }

export interface NativeCaptureRequest {
	readonly op: 'capture'
	readonly target: NativeCaptureTarget
	/** A directory the caller made; the picture is written into it. */
	readonly into?: string
	/** Return a small picture in the reply instead. */
	readonly inline?: boolean
	readonly cursor?: boolean
	readonly timeoutMs?: number
}

export type NativeMonitorHook = 'foreground' | 'input'

/** What to watch; default both. */
export interface NativeMonitorStartRequest {
	readonly op: 'monitor.start'
	readonly hooks?: readonly NativeMonitorHook[]
}

/** What a watch reports. Nothing here is about keys or the mouse: there is no such kind. */
export type NativeWatchKind = 'invoke' | 'focus' | 'selection' | 'menu' | 'window' | 'value' | 'app'

export const NATIVE_WATCH_KINDS: readonly NativeWatchKind[] = [
	'invoke',
	'focus',
	'selection',
	'menu',
	'window',
	'value',
	'app',
]

/** What to watch and how much to keep. Every field is optional; the helper clamps each. */
export interface NativeWatchStartRequest {
	readonly op: 'watch.start'
	/** Default every kind. */
	readonly kinds?: readonly NativeWatchKind[]
	/** Repeated value changes of one control within this many ms are one event (default 250, at most 5000; 0 keeps all). */
	readonly coalesceMs?: number
	/** Events kept between polls (default and most 2000). */
	readonly maxQueue?: number
	/** Characters of a value kept (default and most 200). */
	readonly maxValue?: number
	/** Characters of a control name kept (default and most 80). */
	readonly maxName?: number
}

export type NativePresenceKind = 'click' | 'type' | 'move'

export interface NativePresenceActRequest {
	readonly op: 'presence.act'
	readonly windowId: string
	readonly kind: NativePresenceKind
	/** Where the action lands, in virtual-desktop pixels; absent for typing. */
	readonly at?: { readonly x: number; readonly y: number }
}

export interface NativeLeaseBeginRequest {
	readonly op: 'lease.begin'
	readonly windowId?: string
	readonly raise?: boolean
	readonly idleMs?: number
	readonly ttlMs?: number
	readonly leasePath?: string
	readonly token?: string
}

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

export interface NativeActState {
	readonly value?: string
	readonly toggle?: 'on' | 'off' | 'mixed'
	readonly expand?: 'expanded' | 'collapsed' | 'partial' | 'leaf'
	readonly selected?: boolean
	readonly focused?: boolean
}

export interface NativeActReply {
	/** The pattern call went through. */
	readonly done: boolean
	readonly via: 'pattern'
	/** Whether the read-back shows the effect; absent when there is nothing to read. */
	readonly verified?: boolean
	readonly after?: NativeActState
	/** The control's place in the read that found it, and that read's revision. */
	readonly index: number
	readonly revision: number
}

export interface NativeInputReply {
	readonly delivered: number
	readonly via: 'sendinput'
	readonly cursor?: { readonly x: number; readonly y: number }
}

export interface NativeCaptureReply {
	readonly path?: string
	readonly dataBase64?: string
	readonly bytes: number
	readonly width: number
	readonly height: number
	readonly scale: number
	readonly via: 'wgc' | 'printwindow' | 'bitblt'
	readonly sha256: string
	readonly bounds: A11yRect
	readonly display?: string
}

export interface NativeForegroundWindow {
	readonly windowId: string
	readonly processId: number
	readonly exe: string
	readonly elevated: boolean
	/** The integrity level as a RID (0x2000 medium, 0x3000 high); -1 when unreadable. */
	readonly integrity: number
}

export interface NativeForegroundState {
	readonly foreground: NativeForegroundWindow | null
	readonly cursor: { readonly x: number; readonly y: number }
	readonly desktop: string
	readonly selfElevated: boolean
	readonly selfIntegrity: number
	readonly inputTick: number
	readonly userIdleMs: number
	readonly target?: {
		readonly exe: string
		readonly elevated: boolean
		readonly integrity: number
	}
}

export type NativeRaiseHow = 'already' | 'plain' | 'unlock' | 'attach' | 'switch' | 'refused'

export interface NativeForegroundSetReply {
	readonly raised: boolean
	readonly changed: boolean
	readonly how: NativeRaiseHow
	readonly blockedBy?: 'windows' | 'elevated'
}

export interface NativeLeaseBeginReply extends NativeForegroundState {
	readonly refused: boolean
	readonly raised?: boolean
	readonly raiseHow?: NativeRaiseHow
}

export interface NativeLeaseEndReply {
	readonly restoredForeground: boolean
	readonly restoredCursor: boolean
	readonly restoreNote?: string
	readonly inputMoved: boolean
	readonly frontElevated: boolean
	readonly released: boolean
	/** A person's input events between begin and end; absent when the monitor was not running throughout. */
	readonly inputsDuring?: number
}

export interface NativeMonitorStartReply {
	/** Raw Input is registered: a person's use of keyboard and mouse is seen. */
	readonly input: boolean
	/** Foreground changes are hooked. */
	readonly foreground: boolean
}

/**
 * One thing that happened. Input carries the device class and a time only,
 * never a key, a character or a position.
 */
export interface NativeMonitorEvent {
	readonly seq: number
	readonly kind: 'input' | 'foreground'
	/** ms since the monitor started. */
	readonly tMs: number
	readonly device?: 'keyboard' | 'mouse'
	/** The system synthesised the input (SendInput, from this helper or another program). */
	readonly injected?: boolean
	/** For a foreground change: the window that came to the front. */
	readonly windowId?: string
}

export interface NativeMonitorPollReply {
	readonly events: readonly NativeMonitorEvent[]
	readonly seq: number
	/** Events a person's devices produced since the monitor started. */
	readonly inputs: number
	readonly injectedInputs: number
	readonly foregroundChanges: number
	/** ms since a person's last input, when there was one. */
	readonly lastInputAgoMs?: number
	/** `since` was older than the oldest event kept. */
	readonly dropped: boolean
}

export interface NativeWatchStartReply {
	/** UI Automation subscriptions are in place; false: the controls of programs are not watched. */
	readonly controls: boolean
	/** Foreground changes are hooked. */
	readonly foreground: boolean
	/** The kinds being watched. */
	readonly kinds: readonly NativeWatchKind[]
}

/**
 * One thing a person did to a control, or a window that opened or closed.
 * There is no key, no character typed and no mouse button or position in it;
 * `value` is an ordinary edit control's text and is never present for a
 * password field, which says `secure: true` instead.
 */
export interface NativeWatchEvent {
	readonly kind: NativeWatchKind
	/** Monotonic ms since the watch started. */
	readonly tMs: number
	readonly role?: string
	readonly name?: string
	readonly value?: string
	readonly secure?: boolean
	/** For a menu or a window: which end. */
	readonly phase?: 'open' | 'close'
	/** The title of the window the control is in. */
	readonly window?: string
	/** The program's file name. */
	readonly process?: string
	readonly windowId?: string
}

export interface NativeWatchPollReply {
	/** Events since the last poll, oldest first. */
	readonly events: readonly NativeWatchEvent[]
	/** Events not kept since the last poll because the queue was full. */
	readonly dropped: number
}

export interface NativePresenceActReply {
	readonly cursorWindow: number
	readonly frameWindow: number
}

export interface NativeReplyBodies {
	readonly hello: NativeHello
	readonly windows: { readonly windows: readonly A11yWindow[] }
	readonly displays: { readonly displays: readonly A11yDisplay[] }
	readonly snapshot: NativeSnapshot
	readonly identity: { readonly fingerprint: A11yFingerprint }
	readonly resolve: NativeResolution
	readonly seq: { readonly seq: number }
	readonly wait_change: NativeWaitResult
	readonly act: NativeActReply
	readonly input: NativeInputReply
	readonly capture: NativeCaptureReply
	readonly 'foreground.get': NativeForegroundState
	readonly 'foreground.set': NativeForegroundSetReply
	readonly 'lease.begin': NativeLeaseBeginReply
	readonly 'lease.end': NativeLeaseEndReply
	readonly 'monitor.start': NativeMonitorStartReply
	readonly 'monitor.stop': Record<string, never>
	readonly 'monitor.poll': NativeMonitorPollReply
	readonly 'watch.start': NativeWatchStartReply
	readonly 'watch.stop': Record<string, never>
	readonly 'watch.poll': NativeWatchPollReply
	readonly 'presence.act': NativePresenceActReply
	readonly 'presence.hide': Record<string, never>
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

function fingerprint(v: unknown, path: string): A11yFingerprint {
	const o = obj(v, path)
	return {
		runtimeId: str(o, 'runtimeId', path),
		automationId: str(o, 'automationId', path),
		role: str(o, 'role', path),
		nameHash: str(o, 'nameHash', path),
		parentPath: str(o, 'parentPath', path),
		ordinal: int(o, 'ordinal', path),
		processStart: int(o, 'processStart', path),
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

function point(v: unknown, path: string): { x: number; y: number } {
	const o = obj(v, path)
	return {
		x: int(o, 'x', path, Number.MIN_SAFE_INTEGER),
		y: int(o, 'y', path, Number.MIN_SAFE_INTEGER),
	}
}

const RAISE_HOW: readonly NativeRaiseHow[] = [
	'already',
	'plain',
	'unlock',
	'attach',
	'switch',
	'refused',
]

function actState(v: unknown, path: string): NativeActState {
	const o = obj(v, path)
	const out: { -readonly [K in keyof NativeActState]: NativeActState[K] } = {}
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
	const focused = optBool(o, 'focused', path)
	if (focused !== undefined) out.focused = focused
	return out
}

function actReply(o: Obj): NativeActReply {
	const out: { -readonly [K in keyof NativeActReply]: NativeActReply[K] } = {
		done: bool(o, 'done', 'act'),
		via: oneOf<'pattern'>(o.via, ['pattern'], 'act.via'),
		index: int(o, 'index', 'act'),
		revision: int(o, 'revision', 'act'),
	}
	const verified = optBool(o, 'verified', 'act')
	if (verified !== undefined) out.verified = verified
	if (o.after !== undefined) out.after = actState(o.after, 'act.after')
	return out
}

function inputReply(o: Obj): NativeInputReply {
	const out: { -readonly [K in keyof NativeInputReply]: NativeInputReply[K] } = {
		delivered: int(o, 'delivered', 'input'),
		via: oneOf<'sendinput'>(o.via, ['sendinput'], 'input.via'),
	}
	if (o.cursor !== undefined) out.cursor = point(o.cursor, 'input.cursor')
	return out
}

function captureReply(o: Obj): NativeCaptureReply {
	const out: { -readonly [K in keyof NativeCaptureReply]: NativeCaptureReply[K] } = {
		bytes: int(o, 'bytes', 'capture'),
		width: int(o, 'width', 'capture'),
		height: int(o, 'height', 'capture'),
		scale: num(o, 'scale', 'capture'),
		via: oneOf<'wgc' | 'printwindow' | 'bitblt'>(
			o.via,
			['wgc', 'printwindow', 'bitblt'],
			'capture.via',
		),
		sha256: str(o, 'sha256', 'capture'),
		bounds: rect(o, 'bounds', 'capture'),
	}
	const path = optStr(o, 'path', 'capture')
	if (path !== undefined) out.path = path
	const data = optStr(o, 'dataBase64', 'capture')
	if (data !== undefined) out.dataBase64 = data
	const display = optStr(o, 'display', 'capture')
	if (display !== undefined) out.display = display
	return out
}

function foregroundState(o: Obj, path: string): NativeForegroundState {
	let foreground: NativeForegroundWindow | null = null
	if (o.foreground === undefined) bad(`${path}.foreground`, 'a window or null')
	if (o.foreground !== null) {
		const f = obj(o.foreground, `${path}.foreground`)
		const p = `${path}.foreground`
		foreground = {
			windowId: str(f, 'windowId', p),
			processId: int(f, 'processId', p),
			exe: str(f, 'exe', p),
			elevated: bool(f, 'elevated', p),
			integrity: int(f, 'integrity', p, -1),
		}
	}
	const out: { -readonly [K in keyof NativeForegroundState]: NativeForegroundState[K] } = {
		foreground,
		cursor: point(o.cursor, `${path}.cursor`),
		desktop: str(o, 'desktop', path),
		selfElevated: bool(o, 'selfElevated', path),
		selfIntegrity: int(o, 'selfIntegrity', path, -1),
		inputTick: int(o, 'inputTick', path),
		userIdleMs: int(o, 'userIdleMs', path),
	}
	if (o.target !== undefined) {
		const t = obj(o.target, `${path}.target`)
		out.target = {
			exe: str(t, 'exe', `${path}.target`),
			elevated: bool(t, 'elevated', `${path}.target`),
			integrity: int(t, 'integrity', `${path}.target`, -1),
		}
	}
	return out
}

function foregroundSet(o: Obj): NativeForegroundSetReply {
	const out: { -readonly [K in keyof NativeForegroundSetReply]: NativeForegroundSetReply[K] } = {
		raised: bool(o, 'raised', 'foreground.set'),
		changed: bool(o, 'changed', 'foreground.set'),
		how: oneOf(o.how, RAISE_HOW, 'foreground.set.how'),
	}
	if (o.blockedBy !== undefined)
		out.blockedBy = oneOf<'windows' | 'elevated'>(
			o.blockedBy,
			['windows', 'elevated'],
			'foreground.set.blockedBy',
		)
	return out
}

function leaseBegin(o: Obj): NativeLeaseBeginReply {
	const out: { -readonly [K in keyof NativeLeaseBeginReply]: NativeLeaseBeginReply[K] } = {
		...foregroundState(o, 'lease.begin'),
		refused: bool(o, 'refused', 'lease.begin'),
	}
	const raised = optBool(o, 'raised', 'lease.begin')
	if (raised !== undefined) out.raised = raised
	if (o.raiseHow !== undefined) out.raiseHow = oneOf(o.raiseHow, RAISE_HOW, 'lease.begin.raiseHow')
	return out
}

function leaseEnd(o: Obj): NativeLeaseEndReply {
	const out: { -readonly [K in keyof NativeLeaseEndReply]: NativeLeaseEndReply[K] } = {
		restoredForeground: bool(o, 'restoredForeground', 'lease.end'),
		restoredCursor: bool(o, 'restoredCursor', 'lease.end'),
		inputMoved: bool(o, 'inputMoved', 'lease.end'),
		frontElevated: bool(o, 'frontElevated', 'lease.end'),
		released: bool(o, 'released', 'lease.end'),
	}
	const note = optStr(o, 'restoreNote', 'lease.end')
	if (note !== undefined) out.restoreNote = note
	const during = optInt(o, 'inputsDuring', 'lease.end')
	if (during !== undefined) out.inputsDuring = during
	return out
}

function monitorEvent(v: unknown, path: string): NativeMonitorEvent {
	const o = obj(v, path)
	const out: { -readonly [K in keyof NativeMonitorEvent]: NativeMonitorEvent[K] } = {
		seq: int(o, 'seq', path),
		kind: oneOf<'input' | 'foreground'>(o.kind, ['input', 'foreground'], `${path}.kind`),
		tMs: int(o, 'tMs', path),
	}
	if (o.device !== undefined)
		out.device = oneOf<'keyboard' | 'mouse'>(o.device, ['keyboard', 'mouse'], `${path}.device`)
	const injected = optBool(o, 'injected', path)
	if (injected !== undefined) out.injected = injected
	const windowId = optStr(o, 'windowId', path)
	if (windowId !== undefined) out.windowId = windowId
	return out
}

function monitorPoll(o: Obj): NativeMonitorPollReply {
	const out: { -readonly [K in keyof NativeMonitorPollReply]: NativeMonitorPollReply[K] } = {
		events: arr(o, 'events', 'monitor.poll').map((e, i) =>
			monitorEvent(e, `monitor.poll.events[${i}]`),
		),
		seq: int(o, 'seq', 'monitor.poll'),
		inputs: int(o, 'inputs', 'monitor.poll'),
		injectedInputs: int(o, 'injectedInputs', 'monitor.poll'),
		foregroundChanges: int(o, 'foregroundChanges', 'monitor.poll'),
		dropped: bool(o, 'dropped', 'monitor.poll'),
	}
	const ago = optInt(o, 'lastInputAgoMs', 'monitor.poll')
	if (ago !== undefined) out.lastInputAgoMs = ago
	return out
}

function watchKind(v: unknown, path: string): NativeWatchKind {
	return oneOf(v, NATIVE_WATCH_KINDS, path)
}

function watchEvent(v: unknown, path: string): NativeWatchEvent {
	const o = obj(v, path)
	const out: { -readonly [K in keyof NativeWatchEvent]: NativeWatchEvent[K] } = {
		kind: watchKind(o.kind, `${path}.kind`),
		tMs: int(o, 'tMs', path),
	}
	for (const key of ['role', 'name', 'value', 'window', 'process', 'windowId'] as const) {
		const text = optStr(o, key, path)
		if (text !== undefined) out[key] = text
	}
	const secure = optBool(o, 'secure', path)
	if (secure !== undefined) out.secure = secure
	if (o.phase !== undefined) out.phase = oneOf(o.phase, ['open', 'close'] as const, `${path}.phase`)
	// A password field never carries its text, whatever a helper sent.
	if (out.secure === true && out.value !== undefined)
		bad(`${path}.value`, 'absent for a secure field')
	return out
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
		case 'identity':
			return { fingerprint: fingerprint(o.fingerprint, 'identity.fingerprint') }
		case 'resolve':
			return resolution(o)
		case 'seq':
			return { seq: int(o, 'seq', 'seq') }
		case 'wait_change':
			return waitResult(o)
		case 'act':
			return actReply(o)
		case 'input':
			return inputReply(o)
		case 'capture':
			return captureReply(o)
		case 'foreground.get':
			return foregroundState(o, 'foreground.get')
		case 'foreground.set':
			return foregroundSet(o)
		case 'lease.begin':
			return leaseBegin(o)
		case 'lease.end':
			return leaseEnd(o)
		case 'monitor.start':
			return {
				input: bool(o, 'input', 'monitor.start'),
				foreground: bool(o, 'foreground', 'monitor.start'),
			}
		case 'monitor.poll':
			return monitorPoll(o)
		case 'watch.start':
			return {
				controls: bool(o, 'controls', 'watch.start'),
				foreground: bool(o, 'foreground', 'watch.start'),
				kinds: arr(o, 'kinds', 'watch.start').map((k, i) =>
					watchKind(k, `watch.start.kinds[${i}]`),
				),
			}
		case 'watch.poll':
			return {
				events: arr(o, 'events', 'watch.poll').map((e, i) =>
					watchEvent(e, `watch.poll.events[${i}]`),
				),
				dropped: int(o, 'dropped', 'watch.poll'),
			}
		case 'presence.act':
			return {
				cursorWindow: int(o, 'cursorWindow', 'presence.act'),
				frameWindow: int(o, 'frameWindow', 'presence.act'),
			}
		case 'monitor.stop':
		case 'watch.stop':
		case 'presence.hide':
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
