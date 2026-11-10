import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const asked = vi.hoisted(() => ({ windowsHome: '' as string, calls: 0 }))

// The real lookup starts a Windows process on WSL; the test counts how often
// discovery asks, and answers from a fixture directory.
vi.mock('./harness-credentials.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('./harness-credentials.js')>()),
	wslWindowsHome: () => {
		asked.calls += 1
		return asked.windowsHome
	},
}))

import { discoverProviders, findDetected } from './discover.js'
import { claudeCredentialsPath, codexCredentialsPath } from './harness-credentials.js'

describe('discoverProviders on WSL', () => {
	it('asks Windows for the paired home once and every credential family reads that answer', async () => {
		const linuxHome = mkdtempSync(join(tmpdir(), 'namzu-discover-linux-'))
		const windowsHome = mkdtempSync(join(tmpdir(), 'namzu-discover-win-'))
		asked.windowsHome = windowsHome
		const write = (path: string, value: unknown) => {
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
		}
		write(claudeCredentialsPath(windowsHome, {}), {
			claudeAiOauth: {
				accessToken: 'windows-claude',
				refreshToken: 'windows-claude-refresh',
				expiresAt: Date.now() + 120_000,
			},
		})
		write(codexCredentialsPath(windowsHome, {}), {
			tokens: { access_token: 'windows-codex', account_id: 'windows-account' },
		})
		// `home` undefined is the real launch: the paired home is looked up.
		const list = await discoverProviders({
			skipProbes: true,
			skipKeychain: true,
			skipStored: true,
			env: { WSL_DISTRO_NAME: 'test', HOME: linuxHome },
		})
		expect(asked.calls).toBe(1)
		expect(findDetected(list, 'anthropic')?.apiKey).toBe('windows-claude')
		expect(findDetected(list, 'codex')?.apiKey).toBe('windows-codex')
	})
})
