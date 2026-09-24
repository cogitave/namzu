import { describe, expect, it, vi } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import type { Adapter } from '../adapters/types.js'
import { ComputerUseOutcomeUnknownError } from '../errors.js'
import { SpawnError } from '../util/spawn.js'

function makeAdapter(): Adapter {
	return {
		capabilities: Object.freeze({
			displayServer: 'darwin',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: false,
			clipboard: true,
		}),
		async getDisplayGeometry() {
			return { width: 1920, height: 1080, scaleFactor: 2 }
		},
		async execute(action) {
			if (action.type === 'screenshot') {
				return {
					type: 'screenshot',
					result: {
						data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
						mimeType: 'image/png',
						width: 10,
						height: 10,
					},
				}
			}
			return { type: 'ok' }
		},
	}
}

function spawnFailure(options: { timedOut?: boolean; exitCode?: number } = {}): SpawnError {
	const timedOut = options.timedOut ?? false
	const exitCode = options.exitCode ?? (timedOut ? -1 : 7)
	return new SpawnError(
		'desktop subprocess failed after start',
		{
			exitCode,
			stdout: Buffer.alloc(0),
			stderr: 'late failure',
			timedOut,
			signal: timedOut ? 'SIGKILL' : null,
		},
		'desktop-driver',
		[],
	)
}

describe('SubprocessComputerUseHost', () => {
	it('detects the display server before initialize()', () => {
		const host = new SubprocessComputerUseHost({ platform: 'darwin' })
		expect(host.capabilities.displayServer).toBe('darwin')
	})

	it('reports all feature flags false before initialize()', () => {
		const host = new SubprocessComputerUseHost({ platform: 'darwin' })
		expect(host.capabilities.screenshot).toBe(false)
		expect(host.capabilities.mouse).toBe(false)
		expect(host.capabilities.keyboard).toBe(false)
		expect(host.capabilities.cursorPosition).toBe(false)
		expect(host.capabilities.clipboard).toBe(false)
	})

	it('accepts an injected adapter and exposes its capabilities', async () => {
		const host = new SubprocessComputerUseHost({ adapter: makeAdapter() })
		expect(host.capabilities.screenshot).toBe(true)
		expect(host.capabilities.mouse).toBe(true)
		expect(host.capabilities.keyboard).toBe(true)
		expect(host.capabilities.displayServer).toBe('darwin')

		const result = await host.execute({ type: 'screenshot' })
		expect(result.type).toBe('screenshot')
	})

	it('throws on execute before initialize() when no adapter injected', async () => {
		const host = new SubprocessComputerUseHost({ platform: 'darwin' })
		await expect(host.execute({ type: 'screenshot' })).rejects.toThrow('not initialised')
	})

	it('dispose clears the adapter reference without error', async () => {
		const host = new SubprocessComputerUseHost({ adapter: makeAdapter() })
		await expect(host.dispose()).resolves.toBeUndefined()
		await expect(host.execute({ type: 'screenshot' })).rejects.toThrow('not initialised')
	})

	it('dispose stops what the adapter keeps running, once', async () => {
		let disposed = 0
		const adapter: Adapter = {
			...makeAdapter(),
			async dispose() {
				disposed++
			},
		}
		const host = new SubprocessComputerUseHost({ adapter })
		await host.dispose()
		await host.dispose()
		expect(disposed).toBe(1)
	})

	it('forwards the window methods to an adapter that has them, and says so when it does not', async () => {
		const window = {
			id: '0x1',
			title: 'Untitled - Notepad',
			app: 'notepad',
			pid: 1,
			bounds: { x: 0, y: 0, width: 10, height: 10 },
			focused: true,
			minimized: false,
		}
		const adapter: Adapter = {
			...makeAdapter(),
			backend: 'cua-driver 0.28.2',
			async listWindows() {
				return [window]
			},
			async focusWindow(id) {
				return { ok: id === '0x1', focusedId: '0x1' }
			},
		}
		const host = new SubprocessComputerUseHost({ adapter })
		expect(host.backend).toBe('cua-driver 0.28.2')
		await expect(host.listWindows()).resolves.toEqual([window])
		await expect(host.focusWindow('0x1')).resolves.toEqual({ ok: true, focusedId: '0x1' })

		const plain = new SubprocessComputerUseHost({ adapter: makeAdapter() })
		await expect(plain.listWindows()).rejects.toThrow(/listWindows is not supported/)
		await expect(plain.captureRegion({ x: 0, y: 0, width: 1, height: 1 })).rejects.toThrow(
			/captureRegion is not supported/,
		)
	})

	it('names the fallback reason when a fallen-back adapter meets a silent desktop', async () => {
		vi.resetModules()
		vi.doMock('../adapters/win32.js', () => ({
			Win32Adapter: {
				create: async (options: unknown) => {
					seenOptions.push(options)
					return {
						...makeAdapter(),
						backend: 'powershell',
						fallbackReason: 'Could not download cua-driver: fetch failed',
						async getDisplayGeometry() {
							throw new Error('CopyFromScreen: The handle is invalid')
						},
					}
				},
			},
		}))
		const seenOptions: unknown[] = []
		const { SubprocessComputerUseHost: Host } = await import('../SubprocessComputerUseHost.js')
		const host = new Host({
			env: { WSL_DISTRO_NAME: 'archlinux' },
			platform: 'linux',
			windows: { download: false },
		})
		await expect(host.initialize()).rejects.toThrow(
			/handle is invalid \(cua-driver was not used: Could not download cua-driver: fetch failed\)/,
		)
		expect(seenOptions).toEqual([
			{ download: false, env: { WSL_DISTRO_NAME: 'archlinux' }, platform: 'linux' },
		])
		vi.doUnmock('../adapters/win32.js')
	})

	it('rejects initialize() for unknown display server with no adapter', async () => {
		const host = new SubprocessComputerUseHost({ env: {}, platform: 'linux' })
		expect(host.capabilities.displayServer).toBe('unknown')
		await expect(host.initialize()).rejects.toThrow(/no adapter available/)
	})

	it.each([
		{ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'left' } as const,
		{
			type: 'mouse_drag',
			from: { x: 1, y: 2 },
			to: { x: 3, y: 4 },
			button: 'left',
		} as const,
		{ type: 'scroll', at: { x: 1, y: 2 }, direction: 'down', amount: 2 } as const,
		{ type: 'type_text', text: 'hello' } as const,
		{ type: 'key', keys: 'ctrl+c' } as const,
	])('marks a post-start $type failure as outcome unknown', async (action) => {
		const failure = spawnFailure()
		const adapter: Adapter = {
			...makeAdapter(),
			async execute() {
				throw failure
			},
		}
		const host = new SubprocessComputerUseHost({ adapter })

		try {
			await host.execute(action)
			expect.unreachable('the unsafe action should have failed closed')
		} catch (error) {
			expect(error).toBeInstanceOf(ComputerUseOutcomeUnknownError)
			expect(error).toMatchObject({
				code: 'computer_use_outcome_unknown',
				action: action.type,
				outcome: 'unknown',
				retrySafety: 'unsafe',
				timedOut: false,
				exitCode: 7,
			})
			expect((error as Error).message).toMatch(/do not automatically retry/i)
		}
	})

	it('preserves timeout evidence on an unsafe action', async () => {
		const adapter: Adapter = {
			...makeAdapter(),
			async execute() {
				throw spawnFailure({ timedOut: true })
			},
		}
		const host = new SubprocessComputerUseHost({ adapter })

		await expect(host.execute({ type: 'key', keys: 'enter' })).rejects.toMatchObject({
			code: 'computer_use_outcome_unknown',
			timedOut: true,
			exitCode: -1,
		})
	})

	it.each([
		{ type: 'screenshot' } as const,
		{ type: 'cursor_position' } as const,
		{ type: 'mouse_move', to: { x: 1, y: 2 } } as const,
	])('keeps a post-start $type failure as the original retry-safe diagnosis', async (action) => {
		const failure = spawnFailure()
		const adapter: Adapter = {
			...makeAdapter(),
			async execute() {
				throw failure
			},
		}
		const host = new SubprocessComputerUseHost({ adapter })

		await expect(host.execute(action)).rejects.toBe(failure)
	})

	it('does not claim an unknown outcome when the subprocess never started', async () => {
		const failure = new Error('spawn ENOENT')
		const adapter: Adapter = {
			...makeAdapter(),
			async execute() {
				throw failure
			},
		}
		const host = new SubprocessComputerUseHost({ adapter })

		await expect(
			host.execute({ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'left' }),
		).rejects.toBe(failure)
	})
})
