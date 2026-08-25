import { describe, expect, it } from 'vitest'
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
