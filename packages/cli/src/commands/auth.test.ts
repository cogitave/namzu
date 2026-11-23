import { describe, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../integrations/providers/discover.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/registry.js'
import type { Formatter } from '../output/index.js'
import { authStatusRows, renderAuthStatus } from './auth-status.js'
import { createAuthCommand } from './auth.js'

const SECRET_ACCESS = 'sk-ant-oat01-SECRETACCESSTOKENVALUE1234567890'
const SECRET_REFRESH = 'sk-ant-ort01-SECRETREFRESHTOKENVALUE0987654321'
const SECRET_KEY = 'sk-live-SECRETAPIKEYVALUE5555'
const SECRET_ACCOUNT = 'acct-SECRETACCOUNTID777'
const NOW = 1_800_000_000_000

function detected(): DetectedProvider[] {
	return [
		{
			entry: PROVIDER_REGISTRY.anthropic,
			source: { kind: 'stored', path: '/home/u/.namzu/credentials.json' },
			apiKey: SECRET_ACCESS,
			oauth: { refreshToken: SECRET_REFRESH, expiresAt: NOW - 1000, origin: 'stored' },
			alternatives: [{ kind: 'env', envName: 'ANTHROPIC_API_KEY' }],
		},
		{
			entry: PROVIDER_REGISTRY.codex,
			source: { kind: 'stored', path: '/home/u/.namzu/credentials.json' },
			apiKey: SECRET_ACCESS,
			codex: { accountId: SECRET_ACCOUNT, expiresAt: NOW - 1000, origin: 'stored' },
			alternatives: [],
		},
		{
			entry: PROVIDER_REGISTRY.openai,
			source: { kind: 'env', envName: 'OPENAI_API_KEY' },
			apiKey: SECRET_KEY,
			alternatives: [],
		},
		{
			entry: PROVIDER_REGISTRY.ollama,
			source: { kind: 'probe', url: 'http://localhost:11434' },
			alternatives: [],
		},
	]
}

function harness(found: DetectedProvider[]) {
	const printed: string[] = []
	const errors: string[] = []
	const formatter: Formatter = {
		name: 'text',
		print: (p) => printed.push(JSON.stringify(p)),
		info: () => undefined,
		error: (p) => errors.push(JSON.stringify(p)),
	}
	const command = createAuthCommand({ discover: async () => found, now: () => NOW })
	return {
		printed,
		errors,
		run: (args: string[]) => command.handler({ ctx: { config: {}, formatter }, rawArgs: args }),
	}
}

describe('namzu auth status', () => {
	it('lists each credential with kind and state, and never a secret', async () => {
		const rows = authStatusRows(detected(), NOW)
		expect(rows.map((r) => [r.provider, r.kind, r.state])).toEqual([
			['anthropic', 'subscription', 'usable'],
			['anthropic', 'environment', 'usable'],
			['codex', 'subscription', 'expired'],
			['openai', 'environment', 'usable'],
		])
		const everything = JSON.stringify(rows) + renderAuthStatus(rows)
		for (const secret of [SECRET_ACCESS, SECRET_REFRESH, SECRET_KEY, SECRET_ACCOUNT]) {
			expect(everything).not.toContain(secret)
			expect(everything).not.toContain(secret.slice(0, 8))
		}
	})

	it('exits 0 with a usable credential, 1 with none, in text and in --json', async () => {
		const h = harness(detected())
		expect(await h.run(['status'])).toBe(0)
		const none = harness([])
		expect(await none.run(['status'])).toBe(1)
		expect(none.printed.join('')).toContain('No credentials found')
		const expired = harness(detected().filter((d) => d.entry.id === 'codex'))
		expect(await expired.run(['status'])).toBe(1)
	})

	it('prints the same rows as a JSON array with --json, with no secret', async () => {
		const writes: string[] = []
		const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
			writes.push(String(chunk))
			return true
		})
		try {
			const h = harness(detected())
			expect(await h.run(['status', '--json'])).toBe(0)
		} finally {
			spy.mockRestore()
		}
		const out = writes.join('')
		const parsed = JSON.parse(out) as unknown[]
		expect(Array.isArray(parsed)).toBe(true)
		expect(parsed).toHaveLength(4)
		for (const secret of [SECRET_ACCESS, SECRET_REFRESH, SECRET_KEY, SECRET_ACCOUNT]) {
			expect(out).not.toContain(secret)
		}
	})

	it('treats a sign-in with a refresh token as usable past its expiry', () => {
		const rows = authStatusRows(detected().slice(0, 1), NOW)
		expect(rows[0]?.state).toBe('usable')
	})

	it('refuses an unknown action or option', async () => {
		const h = harness([])
		expect(await h.run([])).toBe(64)
		expect(await h.run(['list'])).toBe(64)
		expect(await h.run(['status', '--bogus'])).toBe(64)
	})
})
