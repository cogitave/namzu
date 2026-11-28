/**
 * The display adapter on top of the native helper, driven by a fake helper:
 * what it asks for each action, how points and pictures are related to the
 * display of the last capture, and what a helper that stops answering turns
 * into. No process is started and no desktop is touched.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdapterUnavailableError } from '../adapters/types.js'
import { NativeWin32Adapter } from '../adapters/win32-native.js'
import { Win32PowerShellAdapter } from '../adapters/win32-powershell.js'
import { Win32Adapter } from '../adapters/win32.js'
import type { NativeChannel } from '../native/process.js'
import { SpawnError } from '../util/spawn.js'

/** A PNG header with the size the test names, and nothing after it. */
function png(width: number, height: number): Buffer {
	const b = Buffer.alloc(33)
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
	b.writeUInt32BE(13, 8)
	b.write('IHDR', 12, 'ascii')
	b.writeUInt32BE(width, 16)
	b.writeUInt32BE(height, 20)
	return b
}

const DISPLAYS = {
	displays: [
		{
			id: '\\\\.\\DISPLAY2',
			bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
			workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
			scale: 1,
			primary: false,
		},
		{
			id: '\\\\.\\DISPLAY1',
			bounds: { x: 0, y: 0, width: 3840, height: 2160 },
			workArea: { x: 0, y: 0, width: 3840, height: 2112 },
			scale: 1.5,
			primary: true,
		},
	],
}

const HELLO = {
	version: '0.2.0',
	buildHash: 'abc',
	arch: 'x86_64',
	osBuild: '26100',
	caps: ['windows', 'displays', 'capture', 'input', 'foreground', 'lease'],
	dpiAwareness: 'perMonitorV2',
}

class FakeHelper implements NativeChannel {
	readonly requests: Record<string, any>[] = []
	killed = false
	/** Ops the fake leaves unanswered. */
	silent = new Set<string>()
	/** Failure replies by op. */
	fails: Record<string, { code: string; message: string }> = {}
	/** What the display list says. */
	displays = DISPLAYS
	/** The size and display of the next picture. */
	picture = { width: 3840, height: 2160, display: '\\\\.\\DISPLAY1' }
	hello: Record<string, unknown> = HELLO
	private line: ((line: string) => void) | undefined
	private exit: (() => void) | undefined
	private pictures = 0

	write(line: string): void {
		const request = JSON.parse(line) as Record<string, any>
		this.requests.push(request)
		if (this.silent.has(request.op)) return
		const failure = this.fails[request.op]
		if (failure) {
			this.says({ id: request.id, ok: false, ...failure })
			return
		}
		this.says({ id: request.id, ok: true, ...this.answer(request) })
	}

	private answer(request: Record<string, any>): Record<string, unknown> {
		switch (request.op) {
			case 'hello':
				return this.hello
			case 'displays':
				return this.displays
			case 'capture': {
				const { width, height, display } = this.picture
				const file = join(request.into, `capture-1-${++this.pictures}.png`)
				const bytes = png(width, height)
				writeFileSync(file, bytes)
				const bounds =
					request.target.kind === 'region'
						? { x: request.target.x, y: request.target.y, width, height }
						: { x: 0, y: 0, width, height }
				return {
					path: file,
					bytes: bytes.length,
					width,
					height,
					scale: 1.5,
					via: 'wgc',
					sha256: 'a'.repeat(64),
					bounds,
					display,
				}
			}
			case 'input':
				return { delivered: 2, via: 'sendinput' }
			case 'foreground.get':
				return {
					foreground: null,
					cursor: { x: 150, y: 260 },
					desktop: 'Default',
					selfElevated: false,
					selfIntegrity: 8192,
					inputTick: 1,
					userIdleMs: 9000,
				}
			default:
				return {}
		}
	}

	onLine(handler: (line: string) => void): void {
		this.line = handler
	}
	onExit(handler: () => void): void {
		this.exit = handler
	}
	kill(): void {
		this.killed = true
	}
	says(value: unknown): void {
		this.line?.(JSON.stringify(value))
	}
	exits(): void {
		this.exit?.()
	}
	ops(): string[] {
		return this.requests.map((r) => r.op)
	}
	inputs(): Record<string, any>[] {
		return this.requests.filter((r) => r.op === 'input')
	}
}

const dirs: string[] = []

async function adapter(configure?: (h: FakeHelper) => void) {
	const helpers: FakeHelper[] = []
	const captureDir = mkdtempSync(join(tmpdir(), 'namzu-native-adapter-test-'))
	dirs.push(captureDir)
	const created = await NativeWin32Adapter.create({
		executable: 'C:\\namzu\\namzu-native.exe',
		cliVersion: '55.0.0',
		captureDir,
		spawnHelper: () => {
			const h = new FakeHelper()
			configure?.(h)
			helpers.push(h)
			return h
		},
	})
	return { adapter: created, helper: helpers[0] as FakeHelper, captureDir }
}

afterEach(() => {
	vi.useRealTimers()
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('starting the native display adapter', () => {
	it('reports what it can do and names the helper', async () => {
		const { adapter: a } = await adapter()
		expect(a.backend).toBe('namzu-native 0.2.0')
		expect(a.capabilities).toMatchObject({
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			regionCapture: true,
			maxClickCount: 3,
			mouseClickButtons: ['left', 'right', 'middle'],
		})
		expect(a.capabilities.supportedActions).toEqual([
			'screenshot',
			'cursor_position',
			'mouse_move',
			'mouse_click',
			'mouse_drag',
			'scroll',
			'type_text',
			'key',
		])
	})

	it('is unavailable, and says why, when the helper cannot capture or send input', async () => {
		await expect(
			adapter((h) => {
				h.hello = { ...HELLO, caps: ['windows', 'displays'] }
			}),
		).rejects.toMatchObject({
			name: 'AdapterUnavailableError',
			missing: ['capture', 'input', 'foreground'],
		})
	})

	it('is unavailable when the helper does not start', async () => {
		await expect(
			NativeWin32Adapter.create({
				executable: 'C:\\missing\\namzu-native.exe',
				spawnHelper: () => {
					throw new Error('ENOENT')
				},
			}),
		).rejects.toBeInstanceOf(AdapterUnavailableError)
	})
})

describe('reading the screen', () => {
	it('reports the primary display as the geometry', async () => {
		const { adapter: a } = await adapter()
		expect(await a.getDisplayGeometry()).toEqual({ width: 3840, height: 2160, scaleFactor: 1.5 })
	})

	it('takes the primary display as a picture, reads the file and removes it', async () => {
		const { adapter: a, helper, captureDir } = await adapter()
		const shot = await a.execute({ type: 'screenshot' })
		const capture = helper.requests.find((r) => r.op === 'capture')
		expect(capture).toMatchObject({
			target: { kind: 'display', id: '\\\\.\\DISPLAY1' },
			into: captureDir,
		})
		expect(shot.type).toBe('screenshot')
		if (shot.type !== 'screenshot') throw new Error('unreachable')
		expect(shot.result).toMatchObject({
			mimeType: 'image/png',
			width: 3840,
			height: 2160,
			display: {
				id: '\\\\.\\DISPLAY1',
				x: 0,
				y: 0,
				width: 3840,
				height: 2160,
				scaleFactor: 1.5,
				primary: true,
			},
		})
		expect(shot.result.data.subarray(1, 4).toString('ascii')).toBe('PNG')
		expect(readdirSync(captureDir)).toEqual([])
	})

	it('reads a picture through the local path when the helper names it in its own', async () => {
		const { adapter: a } = await adapter((h) => {
			// The helper writes where it was told but reports the path in Windows form.
			const answer = (h as any).answer.bind(h)
			;(h as any).answer = (request: Record<string, any>) => {
				const reply = answer(request)
				return request.op === 'capture'
					? { ...reply, path: `\\\\wsl.localhost\\Ubuntu\\tmp\\${basename(reply.path as string)}` }
					: reply
			}
		})
		const shot = await a.execute({ type: 'screenshot' })
		expect(shot.type).toBe('screenshot')
	})

	it('puts a region in virtual-desktop pixels from the display of the last capture', async () => {
		const { adapter: a, helper } = await adapter()
		await a.getDisplayGeometry()
		helper.picture = { width: 200, height: 100, display: '\\\\.\\DISPLAY1' }
		const shot = await a.captureRegion?.({ x: 40, y: 60, width: 200, height: 100 })
		expect(helper.requests.filter((r) => r.op === 'capture').at(-1)).toMatchObject({
			target: { kind: 'region', x: 40, y: 60, width: 200, height: 100 },
		})
		expect(shot).toMatchObject({ width: 200, height: 100 })
	})

	it('moves the origin of every point to the display of the last capture', async () => {
		const { adapter: a, helper } = await adapter((h) => {
			// The main display sits at (100, 50) in the virtual desktop.
			h.displays = {
				displays: [
					{ ...DISPLAYS.displays[1], bounds: { x: 100, y: 50, width: 3840, height: 2160 } },
				],
			} as typeof DISPLAYS
		})
		await a.execute({ type: 'screenshot' })
		await a.execute({ type: 'mouse_move', to: { x: 10, y: 20 } })
		await a.execute({ type: 'mouse_click', at: { x: 11, y: 21 }, button: 'right', count: 2 })
		await a.execute({
			type: 'mouse_drag',
			from: { x: 1, y: 2 },
			to: { x: 3, y: 4 },
			button: 'left',
		})
		await a.execute({ type: 'scroll', at: { x: 5, y: 6 }, direction: 'down', amount: 3 })
		expect(helper.inputs().map(({ id: _id, op: _op, ...rest }) => rest)).toEqual([
			{ kind: 'move', x: 110, y: 70 },
			{ kind: 'click', x: 111, y: 71, button: 'right', count: 2 },
			{ kind: 'drag', x: 101, y: 52, toX: 103, toY: 54, button: 'left' },
			{ kind: 'scroll', x: 105, y: 56, direction: 'down', amount: 3 },
		])
		const cursor = await a.execute({ type: 'cursor_position' })
		expect(cursor).toEqual({ type: 'cursor_position', point: { x: 50, y: 210 } })
	})
})

describe('sending input', () => {
	it('types and presses keys as the helper takes them', async () => {
		const { adapter: a, helper } = await adapter()
		await a.execute({ type: 'type_text', text: 'héllo\n' })
		await a.execute({ type: 'key', keys: 'ctrl+shift+t' })
		expect(helper.inputs().map(({ id: _id, op: _op, ...rest }) => rest)).toEqual([
			{ kind: 'type', text: 'héllo\n' },
			{ kind: 'key', keys: 'ctrl+shift+t' },
		])
	})

	it('sends a plain click without a count', async () => {
		const { adapter: a, helper } = await adapter()
		await a.execute({ type: 'mouse_click', at: { x: 7, y: 8 }, button: 'left' })
		const sent = helper.inputs()[0] ?? {}
		expect(sent).toMatchObject({ kind: 'click', x: 7, y: 8, button: 'left' })
		expect(sent).not.toHaveProperty('count')
	})

	it('says what the helper refused, in the helper words', async () => {
		const { adapter: a, helper } = await adapter()
		helper.fails.input = {
			code: 'bad_request',
			message: 'the point (9, 9) is outside every display',
		}
		await expect(
			a.execute({ type: 'mouse_click', at: { x: 9, y: 9 }, button: 'left' }),
		).rejects.toThrow(/outside every display/)
	})

	it('treats input the system only partly took as an unknown outcome', async () => {
		const { adapter: a, helper } = await adapter()
		helper.fails.input = { code: 'input_blocked', message: 'the system took 1 of 4 input events' }
		const error = await a.execute({ type: 'key', keys: 'enter' }).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SpawnError)
		expect((error as SpawnError).result.timedOut).toBe(false)
	})

	it('treats a helper that stops answering after the input was sent as an unknown outcome', async () => {
		vi.useFakeTimers()
		const { adapter: a, helper } = await adapter((h) => h.silent.add('input'))
		const pending = a.execute({ type: 'type_text', text: 'x' }).catch((e: unknown) => e)
		await vi.advanceTimersByTimeAsync(20_000)
		const error = await pending
		expect(error).toBeInstanceOf(SpawnError)
		expect((error as SpawnError).result.timedOut).toBe(true)
		// The helper was told to stop.
		expect(helper.ops()).toContain('cancel')
	})

	it('treats a helper that ends mid-action as an unknown outcome', async () => {
		const { adapter: a, helper } = await adapter((h) => h.silent.add('input'))
		const pending = a.execute({ type: 'key', keys: 'enter' }).catch((e: unknown) => e)
		await Promise.resolve()
		await Promise.resolve()
		helper.exits()
		expect(await pending).toBeInstanceOf(SpawnError)
	})
})

describe('lifecycle', () => {
	it('removes the directory it made, and not one it was given, when disposed', async () => {
		const { adapter: a, captureDir } = await adapter()
		await a.dispose?.()
		expect(existsSync(captureDir)).toBe(true)
		const own = await NativeWin32Adapter.create({
			executable: 'C:\\namzu\\namzu-native.exe',
			spawnHelper: () => new FakeHelper(),
		})
		await own.dispose?.()
	})

	it('can be released while idle and used again', async () => {
		const { adapter: a } = await adapter()
		await a.release?.()
		expect((await a.getDisplayGeometry()).width).toBe(3840)
	})
})

describe('choosing the native helper in the Windows adapter', () => {
	const noCuaDriver = async () => {
		throw new Error('cua-driver is not here')
	}
	// A PowerShell adapter that was asked for is told apart from one that was not.
	const powershell = () =>
		vi
			.spyOn(Win32PowerShellAdapter, 'create')
			.mockRejectedValue(new AdapterUnavailableError('PowerShell was asked for'))

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('uses the helper, not PowerShell, when one is named', async () => {
		const ps = powershell()
		const helpers: FakeHelper[] = []
		const chosen = await Win32Adapter.create({
			backend: 'powershell',
			helper: 'C:\\namzu\\namzu-native.exe',
			platform: 'win32',
			env: {},
			spawnHelper: () => {
				const h = new FakeHelper()
				helpers.push(h)
				return h
			},
		})
		expect(chosen.backend).toBe('namzu-native 0.2.0')
		expect(helpers).toHaveLength(1)
		expect(ps).not.toHaveBeenCalled()
		await chosen.dispose?.()
	})

	it('is chosen by NAMZU_NATIVE_HELPER when cua-driver is not available', async () => {
		const ps = powershell()
		const chosen = await Win32Adapter.create({
			backend: 'auto',
			platform: 'win32',
			env: { NAMZU_NATIVE_HELPER: ' C:\\namzu\\namzu-native.exe ' },
			resolve: noCuaDriver as never,
			spawnHelper: () => new FakeHelper(),
		})
		expect(chosen.backend).toBe('namzu-native 0.2.0')
		expect(ps).not.toHaveBeenCalled()
		await chosen.dispose?.()
	})

	it('never falls back to PowerShell when the named helper does not start', async () => {
		const ps = powershell()
		const failure = await Win32Adapter.create({
			backend: 'auto',
			helper: 'C:\\missing\\namzu-native.exe',
			platform: 'win32',
			env: {},
			resolve: noCuaDriver as never,
			spawnHelper: () => {
				throw new Error('ENOENT')
			},
		}).catch((e: unknown) => e)
		expect(failure).toBeInstanceOf(AdapterUnavailableError)
		expect((failure as Error).message).toMatch(/native helper did not start/)
		expect(ps).not.toHaveBeenCalled()
	})

	it('goes on to PowerShell, as before, when no helper is named', async () => {
		const ps = powershell()
		const failure = await Win32Adapter.create({
			backend: 'auto',
			platform: 'win32',
			env: {},
			resolve: noCuaDriver as never,
		}).catch((e: unknown) => e)
		expect((failure as Error).message).toMatch(/PowerShell was asked for/)
		expect(ps).toHaveBeenCalledTimes(1)
	})

	it('treats a blank NAMZU_NATIVE_HELPER as none', async () => {
		const ps = powershell()
		await Win32Adapter.create({
			backend: 'powershell',
			platform: 'win32',
			env: { NAMZU_NATIVE_HELPER: '   ' },
		}).catch(() => undefined)
		expect(ps).toHaveBeenCalledTimes(1)
	})
})
