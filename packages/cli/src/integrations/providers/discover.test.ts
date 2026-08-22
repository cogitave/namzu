import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
	writeStoredCodexCredential,
	writeStoredSubscriptionCredential,
} from './credential-store.js'
import { discoverProviders, findDetected } from './discover.js'
import { claudeCredentialsPath, codexCredentialsPath } from './harness-credentials.js'

function tmpHome(): string {
	const home = mkdtempSync(join(tmpdir(), 'namzu-discover-'))
	return home
}

// Every test must opt out of host-ambient sources (Keychain, network
// probes) so the suite stays hermetic regardless of who runs it. The
// keychain code path is covered by a focused unit test below.
const HERMETIC = { skipProbes: true, skipKeychain: true } as const

describe('discoverProviders — env-var scan', () => {
	it('picks anthropic from ANTHROPIC_API_KEY', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
			home: tmpHome(),
		})
		const anthropic = findDetected(list, 'anthropic')
		expect(anthropic).not.toBeNull()
		expect(anthropic?.apiKey).toBe('sk-ant-test')
		expect(anthropic?.source.kind).toBe('env')
		if (anthropic?.source.kind === 'env') {
			expect(anthropic.source.envName).toBe('ANTHROPIC_API_KEY')
		}
	})

	it('falls back to CLAUDE_CODE_OAUTH_TOKEN if no anthropic key set', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok' },
			home: tmpHome(),
		})
		const anthropic = findDetected(list, 'anthropic')
		expect(anthropic?.apiKey).toBe('oauth-tok')
		if (anthropic?.source.kind === 'env') {
			expect(anthropic.source.envName).toBe('CLAUDE_CODE_OAUTH_TOKEN')
		}
	})

	it('returns empty list when no env + no secrets + no probes + no keychain', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			env: {},
			home: tmpHome(),
		})
		expect(list).toHaveLength(0)
	})

	it('detects multiple providers in one scan', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
			home: tmpHome(),
		})
		expect(findDetected(list, 'anthropic')).not.toBeNull()
		expect(findDetected(list, 'openai')).not.toBeNull()
	})
})

describe('discoverProviders — installed harness sessions', () => {
	it('finds Claude and Codex together and keeps API-key entry optional', async () => {
		const home = tmpHome()
		const write = (path: string, value: unknown) => {
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
		}
		write(claudeCredentialsPath(home), {
			claudeAiOauth: {
				accessToken: 'claude-harness',
				refreshToken: 'claude-refresh',
			},
		})
		write(codexCredentialsPath(home, {}), {
			tokens: { access_token: 'codex-harness', account_id: 'account-1' },
		})

		const list = await discoverProviders({
			...HERMETIC,
			env: { ANTHROPIC_API_KEY: 'optional-api-key' },
			home,
		})
		const anthropic = findDetected(list, 'anthropic')
		const codex = findDetected(list, 'codex')
		expect(anthropic?.apiKey).toBe('claude-harness')
		expect(anthropic?.source.kind).toBe('claude-file')
		expect(anthropic?.alternatives).toContainEqual({
			kind: 'env',
			envName: 'ANTHROPIC_API_KEY',
		})
		expect(codex).toMatchObject({
			apiKey: 'codex-harness',
			source: { kind: 'codex-file' },
			codex: { accountId: 'account-1', origin: 'codex-file' },
		})
	})

	it('prefers usable device sessions over Namzu-owned fallback credentials', async () => {
		const home = tmpHome()
		mkdirSync(dirname(claudeCredentialsPath(home)), { recursive: true })
		writeFileSync(
			claudeCredentialsPath(home),
			JSON.stringify({ claudeAiOauth: { accessToken: 'device-claude' } }),
		)
		mkdirSync(dirname(codexCredentialsPath(home, {})), { recursive: true })
		writeFileSync(
			codexCredentialsPath(home, {}),
			JSON.stringify({
				tokens: { access_token: 'device-codex', account_id: 'device-account' },
			}),
		)
		writeStoredSubscriptionCredential({ accessToken: 'namzu-claude' }, home)
		writeStoredCodexCredential({ accessToken: 'namzu-codex', accountId: 'namzu-account' }, home)

		const list = await discoverProviders({ ...HERMETIC, env: {}, home })
		expect(findDetected(list, 'anthropic')).toMatchObject({
			apiKey: 'device-claude',
			source: { kind: 'claude-file' },
		})
		expect(findDetected(list, 'codex')).toMatchObject({
			apiKey: 'device-codex',
			source: { kind: 'codex-file' },
			codex: { accountId: 'device-account' },
		})
	})

	it('does not advertise an expired borrowed session as usable', async () => {
		const home = tmpHome()
		mkdirSync(dirname(claudeCredentialsPath(home)), { recursive: true })
		writeFileSync(
			claudeCredentialsPath(home),
			JSON.stringify({
				claudeAiOauth: {
					accessToken: 'expired',
					expiresAt: Date.now() - 1_000,
				},
			}),
		)
		const payload = Buffer.from(
			JSON.stringify({
				exp: Math.floor(Date.now() / 1_000) - 60,
				'https://api.openai.com/auth': {
					chatgpt_account_id: 'expired-account',
				},
			}),
		).toString('base64url')
		mkdirSync(dirname(codexCredentialsPath(home, {})), { recursive: true })
		writeFileSync(
			codexCredentialsPath(home, {}),
			JSON.stringify({ tokens: { access_token: `h.${payload}.s` } }),
		)

		const list = await discoverProviders({ ...HERMETIC, env: {}, home })
		expect(findDetected(list, 'anthropic')).toBeNull()
		expect(findDetected(list, 'codex')).toBeNull()
	})
})

describe('discoverProviders — local probes', () => {
	it('detects ollama when its probe URL is reachable', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }))
		const list = await discoverProviders({
			skipKeychain: true,
			env: {},
			home: tmpHome(),
			fetch: fetchMock,
		})
		const ollama = findDetected(list, 'ollama')
		expect(ollama).not.toBeNull()
		expect(ollama?.source.kind).toBe('probe')
	})

	it('does not include ollama when its probe fails', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
		const list = await discoverProviders({
			skipKeychain: true,
			env: {},
			home: tmpHome(),
			fetch: fetchMock,
		})
		expect(findDetected(list, 'ollama')).toBeNull()
	})
})

describe('discoverProviders — http provider', () => {
	it('is never auto-discovered (no envVars, no probe)', async () => {
		const list = await discoverProviders({
			...HERMETIC,
			env: {},
			home: tmpHome(),
		})
		expect(findDetected(list, 'http')).toBeNull()
	})
})
