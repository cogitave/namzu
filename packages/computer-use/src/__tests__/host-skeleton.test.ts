import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import type { Adapter } from '../adapters/types.js'

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
})
