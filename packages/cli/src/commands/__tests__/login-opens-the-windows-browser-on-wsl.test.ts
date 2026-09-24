/**
 * `namzu login` under WSL opens the sign-in page in the Windows browser.
 *
 * It used to hand the address to `xdg-open`, which under WSL reaches a Linux
 * browser at best and usually nothing, so the operator had to copy the URL by
 * hand. The opener is not mocked here: the command's own call reaches
 * `spawn`, on a machine described as WSL with interop and PowerShell present.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EXIT_OK } from '../../exit-codes.js'
import type { CommandContext } from '../types.js'

const spawn = vi.hoisted(() => vi.fn())
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn,
}))
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		existsSync: (path: string) => path === powershell || actual.existsSync(path),
		// This machine's /etc/wsl.conf may move the drives; the test says it does not.
		readFileSync: ((path: unknown, ...rest: unknown[]) => {
			if (path === '/etc/wsl.conf') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
			return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
		}) as typeof actual.readFileSync,
	}
})
vi.mock('node:os', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:os')>()),
	platform: () => 'linux',
}))

const codex = vi.hoisted(() => vi.fn())
vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return { ...actual, beginCodexDeviceLogin: (...args: unknown[]) => codex(...args) }
})

const { loginCommand } = await import('../login.js')

const signIn = 'https://auth.example.test/codex/device?client_id=app&state=a1&scope=openid'

beforeEach(() => {
	spawn.mockReset()
	spawn.mockReturnValue({ on: vi.fn(), unref: vi.fn() })
	vi.stubEnv('WSL_DISTRO_NAME', 'archlinux')
	vi.stubEnv('WSL_INTEROP', '/run/WSL/240_interop')
	codex.mockResolvedValue({
		url: signIn,
		userCode: 'ABCD-EFGH',
		waitForCompletion: () =>
			Promise.resolve({
				ok: true as const,
				credential: { accessToken: 'codex-secret', accountId: 'account-1' },
				storedAt: '/home/test/.namzu/credentials.json',
			}),
		cancel: vi.fn(),
	})
	return () => vi.unstubAllEnvs()
})

describe('namzu login under WSL', () => {
	it('opens the sign-in page through Windows PowerShell, the address intact', async () => {
		const lines: string[] = []
		const ctx = {
			config: {},
			formatter: {
				name: 'text' as const,
				print: ({ text }: { text: string }) => lines.push(text),
				info: (message: string) => lines.push(message),
				error: ({ message }: { message: string }) => lines.push(message),
			},
		} as unknown as CommandContext

		const code = await loginCommand.handler({ ctx, rawArgs: ['codex'] })

		expect(code).toBe(EXIT_OK)
		expect(spawn).toHaveBeenCalledTimes(1)
		const [command, , options] = spawn.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv },
		]
		expect(command).toBe(powershell)
		expect(options.env.NAMZU_OPEN_URL).toBe(signIn)
		expect(options.env.WSLENV?.split(':')).toContain('NAMZU_OPEN_URL')
		// The URL is still printed: a started launcher is not a visible tab.
		expect(lines.join('\n')).toContain(signIn)
	})
})
