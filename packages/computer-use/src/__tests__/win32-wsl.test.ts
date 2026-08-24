import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => ({
	hasExecutable: vi.fn<(name: string) => Promise<boolean>>(),
	runCommand: vi.fn(),
	runCommandOrThrow: vi.fn(),
}))

vi.mock('../util/spawn.js', () => spawn)

import { Win32Adapter } from '../adapters/win32.js'

describe('the Windows adapter selected through WSL interop', () => {
	beforeEach(() => {
		spawn.hasExecutable.mockReset()
		spawn.runCommand.mockReset()
		spawn.runCommandOrThrow.mockReset()
		spawn.hasExecutable.mockImplementation(async (name) => name === 'powershell.exe')
		spawn.runCommandOrThrow.mockResolvedValue({
			exitCode: 0,
			stdout: Buffer.from('{"width":5120,"height":1440,"scaleFactor":1}'),
			stderr: '',
			timedOut: false,
			signal: null,
		})
	})

	it('pins the discovered .exe instead of probing a Linux-only name again per action', async () => {
		const adapter = await Win32Adapter.create()

		await expect(adapter.getDisplayGeometry()).resolves.toEqual({
			width: 5120,
			height: 1440,
			scaleFactor: 1,
		})

		expect(spawn.hasExecutable.mock.calls.map(([name]) => name)).toEqual([
			'pwsh',
			'powershell',
			'pwsh.exe',
			'powershell.exe',
		])
		expect(spawn.runCommandOrThrow).toHaveBeenCalledTimes(1)
		expect(spawn.runCommandOrThrow.mock.calls[0]?.[0]).toBe('powershell.exe')
	})
})
