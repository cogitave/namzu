import { describe, expect, it, vi } from 'vitest'

import type { Adapter } from '../adapters/types.js'

/**
 * Loading an adapter proves its tools exist on PATH, not that a desktop
 * answers. A WSL process finds PowerShell and may still have no interactive
 * Windows session to capture; the host used to become "ready" on the first
 * and let every later action fail the same way. `initialize()` now asks the
 * desktop one cheap question and refuses to be ready if it does not answer.
 */

const adapter: Adapter = {
	capabilities: Object.freeze({
		displayServer: 'win32',
		screenshot: true,
		mouse: true,
		keyboard: true,
		cursorPosition: true,
		clipboard: true,
	}),
	getDisplayGeometry: vi.fn(async () => {
		throw new Error('CopyFromScreen: The handle is invalid')
	}),
	execute: vi.fn(async () => ({ type: 'ok' as const })),
}

vi.mock('../adapters/win32.js', () => ({
	Win32Adapter: { create: async () => adapter },
}))

describe('a desktop that does not answer', () => {
	it('keeps the host from becoming ready, and says what the desktop said', async () => {
		const { SubprocessComputerUseHost } = await import('../SubprocessComputerUseHost.js')
		const host = new SubprocessComputerUseHost({
			env: { WSL_DISTRO_NAME: 'Ubuntu' },
			platform: 'linux',
		})
		await expect(host.initialize()).rejects.toThrow(/desktop did not answer.*handle is invalid/)
		expect(host.capabilities.screenshot).toBe(false)
		await expect(host.execute({ type: 'screenshot' })).rejects.toThrow(/not initialised/)
	})
})
