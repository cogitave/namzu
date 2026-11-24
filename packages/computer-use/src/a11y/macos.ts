import { mkdirSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { WindowsA11yHost, toNode } from './a11y.js'
import type { A11yProcess, WindowsA11yOptions } from './a11y.js'
import {
	A11yError,
	type A11yFingerprint,
	type A11yNode,
	type A11yRect,
	type A11ySnapshotRequest,
} from './interface.js'
import {
	type EnsureMacHelperOptions,
	type MacHelperPaths,
	connectMacHelper,
	ensureMacHelper,
	socketProcess,
} from './macos-helper.js'
import { a11yDisabledByEnv } from './windows.js'

/** What the helper says about the two permissions it needs, and what the person must click. */
export interface MacPermissions {
	readonly accessibility: boolean
	readonly screenCapture: boolean
	/** The name the person looks for in System Settings. */
	readonly app: string
	readonly bundleId: string
	readonly path: string
	/** One plain sentence per switch that is still off. */
	readonly steps: readonly string[]
}

export interface MacNode extends A11yNode {
	/** Names the control well enough to find it again after the window changed. */
	readonly fingerprint: A11yFingerprint
}

export interface MacTree {
	readonly windowId: string
	readonly revision: number
	readonly nodes: readonly MacNode[]
	readonly total: number
	readonly truncated: boolean
	readonly readMs: number
	readonly app: string
	readonly title: string
	readonly pid: number
	readonly selectedText?: string
}

export interface MacTreeRequest extends A11ySnapshotRequest {
	/** Read only the subtree of this control. */
	readonly root?: A11yFingerprint
}

export type MacControlAction =
	| 'invoke'
	| 'show_menu'
	| 'raise'
	| 'increment'
	| 'decrement'
	| 'scroll_into_view'
	| 'focus'
	| 'set_value'
	| 'toggle'
	| 'select'
	| 'expand'
	| 'collapse'

export interface MacActResult {
	/** False when the control refused or the call could not be made. */
	readonly done: boolean
	readonly detail?: string
	readonly via?: string
	readonly before?: string
	readonly after?: string
	readonly expected?: string
	/** True when the state read back is the one asked for; absent when nothing was asked. */
	readonly verified?: boolean
}

export interface MacCapture {
	readonly data: Buffer
	readonly width: number
	readonly height: number
	readonly via: string
}

export interface MacSelfCheck {
	readonly checks: readonly {
		readonly name: string
		readonly ok: boolean
		readonly detail: string
	}[]
	readonly pid: number
	readonly build: string
	readonly path: string
	readonly os: string
}

const num = (value: unknown, fallback = 0): number =>
	typeof value === 'number' && Number.isFinite(value) ? value : fallback
const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A window id as the helper knows it (a CGWindowID); accepts the decimal or `0x` form. */
export function cgWindowId(windowId: string): number {
	const text = windowId.trim().toLowerCase()
	const value = /^0x[0-9a-f]+$/.test(text)
		? Number.parseInt(text.slice(2), 16)
		: /^\d+$/.test(text)
			? Number.parseInt(text, 10)
			: Number.NaN
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new A11yError('bad_window_id', 'not a window id this backend handed out')
	return value
}

function fingerprintOf(value: unknown): A11yFingerprint {
	const f = (value ?? {}) as Record<string, unknown>
	return {
		runtimeId: str(f.runtimeId),
		automationId: str(f.automationId),
		role: str(f.role),
		nameHash: str(f.nameHash),
		parentPath: str(f.parentPath),
		ordinal: num(f.ordinal),
		processStart: num(f.processStart),
	}
}

export interface MacA11yOptions extends WindowsA11yOptions {
	/** Where window captures are written; the same directory the helper is told. */
	readonly captureDir?: string
}

/**
 * {@link WindowsA11yHost}'s client protocol spoken to the macOS helper, with
 * the questions only macOS has: the permissions, a tree whose controls carry
 * their fingerprint, acting on a control by AX action, window capture and
 * input posted to one process.
 */
export class MacA11yHost extends WindowsA11yHost {
	constructor(options: MacA11yOptions) {
		super({ ...options, id: options.id ?? 'macos-ax', greeting: false })
		this.captureDir = options.captureDir
	}

	private captureDir: string | undefined

	/** Where the helper writes window captures; created owner-only. */
	useCaptureDir(dir: string): void {
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		this.captureDir = dir
	}

	async permissions(
		options: { readonly prompt?: boolean } = {},
		signal?: AbortSignal,
	): Promise<MacPermissions> {
		const reply = await this.request(
			'permissions',
			options.prompt ? { prompt: true } : {},
			options.prompt ? 20_000 : 5_000,
			signal,
		)
		return {
			accessibility: reply.accessibility === true,
			screenCapture: reply.screenCapture === true,
			app: str(reply.app) || 'Namzu Helper',
			bundleId: str(reply.bundleId),
			path: str(reply.path),
			steps: Array.isArray(reply.steps) ? reply.steps.filter((s) => typeof s === 'string') : [],
		}
	}

	async readTree(request: MacTreeRequest, signal?: AbortSignal): Promise<MacTree> {
		const timeoutMs = request.timeoutMs ?? 8_000
		const reply = await this.request(
			'snapshot',
			{
				hwnd: cgWindowId(request.windowId),
				timeoutMs,
				...(request.maxNodes !== undefined ? { maxNodes: request.maxNodes } : {}),
				...(request.maxDepth !== undefined ? { maxDepth: request.maxDepth } : {}),
				...(request.skeleton ? { skeleton: true } : {}),
				...(request.allowChromium ? { allowChromium: true } : {}),
				...(request.root ? { root: request.root } : {}),
			},
			timeoutMs,
			signal,
		)
		const raw = (Array.isArray(reply.nodes) ? reply.nodes : []) as Record<string, unknown>[]
		return {
			windowId: String(cgWindowId(request.windowId)),
			revision: num(reply.rev),
			nodes: raw.map((n) => ({ ...toNode(n), fingerprint: fingerprintOf(n.fp) })),
			total: num(reply.total),
			truncated: reply.truncated === true,
			readMs: num(reply.readMs),
			app: str(reply.app),
			title: str(reply.title),
			pid: num(reply.pid),
			...(typeof reply.selectedText === 'string' ? { selectedText: reply.selectedText } : {}),
		}
	}

	async act(
		request: {
			readonly windowId: string
			readonly fingerprint: A11yFingerprint
			readonly action: MacControlAction
			readonly value?: string
		},
		signal?: AbortSignal,
	): Promise<MacActResult> {
		const reply = await this.request(
			'act',
			{
				hwnd: cgWindowId(request.windowId),
				fingerprint: request.fingerprint,
				action: request.action,
				...(request.value !== undefined ? { value: request.value } : {}),
			},
			10_000,
			signal,
		)
		return {
			done: reply.done === true,
			...(typeof reply.detail === 'string' ? { detail: reply.detail } : {}),
			...(typeof reply.via === 'string' ? { via: reply.via } : {}),
			...(typeof reply.before === 'string' ? { before: reply.before } : {}),
			...(typeof reply.after === 'string' ? { after: reply.after } : {}),
			...(typeof reply.expected === 'string' ? { expected: reply.expected } : {}),
			...(typeof reply.verified === 'boolean' ? { verified: reply.verified } : {}),
		}
	}

	/** Brings a window forward; the window that is in front afterwards, as an id, or null. */
	async focus(
		windowId: string,
		signal?: AbortSignal,
	): Promise<{ ok: boolean; focusedId: string | null }> {
		const reply = await this.request('focus', { hwnd: cgWindowId(windowId) }, 8_000, signal)
		return {
			ok: reply.ok === true,
			focusedId: typeof reply.focusedId === 'number' ? String(reply.focusedId) : null,
		}
	}

	/** Wheel scroll in lines, posted to the window's process; `at` is a global point in physical pixels. */
	async scroll(
		request: {
			readonly windowId?: string
			readonly direction: 'up' | 'down' | 'left' | 'right'
			readonly amount: number
			/** Global screen points (not pixels). */
			readonly at?: { readonly x: number; readonly y: number }
		},
		signal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'scroll',
			{
				...(request.windowId ? { hwnd: cgWindowId(request.windowId) } : {}),
				direction: request.direction,
				amount: request.amount,
				...(request.at ? { x: request.at.x, y: request.at.y } : {}),
			},
			5_000,
			signal,
		)
	}

	/** Clicks, double-clicks or drags at global screen points, posted to the window's process. */
	async click(
		request: {
			readonly windowId?: string
			readonly x: number
			readonly y: number
			readonly button?: 'left' | 'right'
			readonly count?: number
			readonly to?: { readonly x: number; readonly y: number }
		},
		signal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'click',
			{
				...(request.windowId ? { hwnd: cgWindowId(request.windowId) } : {}),
				x: request.x,
				y: request.y,
				...(request.button ? { button: request.button } : {}),
				...(request.count ? { count: request.count } : {}),
				...(request.to ? { to: request.to } : {}),
			},
			8_000,
			signal,
		)
	}

	async typeText(
		request: { readonly windowId?: string; readonly text: string },
		signal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'type',
			{
				...(request.windowId ? { hwnd: cgWindowId(request.windowId) } : {}),
				text: request.text,
			},
			10_000 + request.text.length * 4,
			signal,
		)
	}

	async pressKey(
		request: {
			readonly windowId?: string
			readonly code: number
			readonly flags: readonly string[]
		},
		signal?: AbortSignal,
	): Promise<void> {
		await this.request(
			'key',
			{
				...(request.windowId ? { hwnd: cgWindowId(request.windowId) } : {}),
				code: request.code,
				flags: request.flags,
			},
			5_000,
			signal,
		)
	}

	/** One window as a PNG, whatever is in front of it. Needs Screen Recording. */
	async captureWindow(windowId: string, signal?: AbortSignal): Promise<MacCapture> {
		if (!this.captureDir)
			throw new A11yError('unavailable', 'the accessibility host has no capture folder')
		const reply = await this.request(
			'capture_window',
			{ hwnd: cgWindowId(windowId), dir: this.captureDir },
			15_000,
			signal,
		)
		const path = str(reply.path)
		if (!path.startsWith(this.captureDir))
			throw new A11yError('bad_reply', 'the helper named a capture outside its folder')
		try {
			return {
				data: await readFile(path),
				width: num(reply.width),
				height: num(reply.height),
				via: str(reply.via),
			}
		} finally {
			await unlink(path).catch(() => undefined)
		}
	}

	async selfCheck(signal?: AbortSignal): Promise<MacSelfCheck> {
		const reply = await this.request('selfcheck', {}, 8_000, signal)
		const checks = (Array.isArray(reply.checks) ? reply.checks : []) as Record<string, unknown>[]
		return {
			checks: checks.map((c) => ({ name: str(c.name), ok: c.ok === true, detail: str(c.detail) })),
			pid: num(reply.pid),
			build: str(reply.build),
			path: str(reply.path),
			os: str(reply.os),
		}
	}

	/**
	 * The helper reads, acts on and watches a small window of its own and reports each step. Needs no
	 * permission (an app may read itself), so it tells a broken helper from a missing grant.
	 */
	async selfTest(signal?: AbortSignal): Promise<MacSelfCheck['checks']> {
		const reply = await this.request('selftest', {}, 25_000, signal)
		const checks = (Array.isArray(reply.checks) ? reply.checks : []) as Record<string, unknown>[]
		return checks.map((c) => ({ name: str(c.name), ok: c.ok === true, detail: str(c.detail) }))
	}

	/** The rectangle as the helper reports it, for callers that read raw replies. */
	static rect(value: unknown): A11yRect {
		const r = Array.isArray(value) ? value : []
		return { x: num(r[0]), y: num(r[1]), width: num(r[2]), height: num(r[3]) }
	}
}

export interface MacA11yFactoryOptions {
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	/** Default true. `false` starts nothing, whatever the environment says. */
	readonly enabled?: boolean
	readonly onNotice?: (notice: string) => void
	/** For tests: a helper that is not the real one. */
	readonly spawnHelper?: () => A11yProcess
	/** For tests. */
	readonly ensure?: (options: EnsureMacHelperOptions) => Promise<MacHelperPaths>
}

/** The macOS accessibility host plus the step that builds its helper. */
export interface MacA11yHandle {
	readonly host: MacA11yHost
	/**
	 * Builds the helper when it is not built yet and starts it. Resolves with
	 * why it cannot (no compiler, no desktop session) instead of throwing.
	 */
	prepare(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>
}

/**
 * The accessibility host for this Mac, or undefined when it is turned off
 * (`NAMZU_COMPUTER_USE_A11Y=off`) or this is not macOS. Nothing is built or
 * started until `prepare()`.
 */
export function createMacA11yHost(options: MacA11yFactoryOptions = {}): MacA11yHandle | undefined {
	const env = options.env ?? process.env
	const platform = options.platform ?? process.platform
	if (options.enabled === false || a11yDisabledByEnv(env)) return undefined
	if (platform !== 'darwin' && !options.spawnHelper) return undefined
	let paths: MacHelperPaths | undefined
	let building: Promise<MacHelperPaths> | undefined
	const ensure = (): Promise<MacHelperPaths> => {
		building ??= (options.ensure ?? ensureMacHelper)({
			env,
			...(options.onNotice ? { onNotice: options.onNotice } : {}),
		}).then(
			(p) => {
				paths = p
				return p
			},
			(error: unknown) => {
				building = undefined
				throw error
			},
		)
		return building
	}
	const host = new MacA11yHost({
		// A real helper may need a first compile before it can start; the compile has its own wait.
		startTimeoutMs: 60_000,
		spawnHelper:
			options.spawnHelper ??
			(() =>
				socketProcess(async () => {
					const p = paths ?? (await ensure())
					return connectMacHelper({ paths: p, env })
				})),
	})
	return {
		host,
		async prepare() {
			if (options.spawnHelper)
				return (await host.ready())
					? { ok: true }
					: { ok: false, reason: 'the helper did not answer' }
			try {
				const p = await ensure()
				host.useCaptureDir(p.captures)
				if (await host.ready()) return { ok: true }
				return {
					ok: false,
					reason:
						'the macOS helper did not start; it must be launched from a logged-in desktop session',
				}
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) }
			}
		},
	}
}
