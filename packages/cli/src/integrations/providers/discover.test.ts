import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { discoverProviders, findDetected } from './discover.js'

function tmpHome(): string {
	const home = mkdtempSync(join(tmpdir(), 'namzu-discover-'))
	mkdirSync(join(home, '.config', 'clawtool'), { recursive: true })
	return home
}

describe('discoverProviders — env-var scan', () => {
	it('picks anthropic from ANTHROPIC_API_KEY', async () => {
		const list = await discoverProviders({
			env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
			home: tmpHome(),
			skipProbes: true,
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
			env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok' },
			home: tmpHome(),
			skipProbes: true,
		})
		const anthropic = findDetected(list, 'anthropic')
		expect(anthropic?.apiKey).toBe('oauth-tok')
		if (anthropic?.source.kind === 'env') {
			expect(anthropic.source.envName).toBe('CLAUDE_CODE_OAUTH_TOKEN')
		}
	})

	it('returns empty list when no env + no secrets + no probes', async () => {
		const list = await discoverProviders({
			env: {},
			home: tmpHome(),
			skipProbes: true,
		})
		expect(list).toHaveLength(0)
	})

	it('detects multiple providers in one scan', async () => {
		const list = await discoverProviders({
			env: { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' },
			home: tmpHome(),
			skipProbes: true,
		})
		expect(findDetected(list, 'anthropic')).not.toBeNull()
		expect(findDetected(list, 'openai')).not.toBeNull()
	})
})

describe('discoverProviders — clawtool secrets.toml', () => {
	it('reads anthropic key from clawtool secrets', async () => {
		const home = tmpHome()
		writeFileSync(
			join(home, '.config', 'clawtool', 'secrets.toml'),
			'[secrets.work]\nANTHROPIC_API_KEY = "sk-from-toml"\n',
		)
		const list = await discoverProviders({ env: {}, home, skipProbes: true })
		const anthropic = findDetected(list, 'anthropic')
		expect(anthropic?.apiKey).toBe('sk-from-toml')
		if (anthropic?.source.kind === 'secrets-toml') {
			expect(anthropic.source.scope).toBe('work')
			expect(anthropic.source.envName).toBe('ANTHROPIC_API_KEY')
		}
	})

	it('env var wins over secrets.toml when both present', async () => {
		const home = tmpHome()
		writeFileSync(
			join(home, '.config', 'clawtool', 'secrets.toml'),
			'[secrets.work]\nANTHROPIC_API_KEY = "from-toml"\n',
		)
		const list = await discoverProviders({
			env: { ANTHROPIC_API_KEY: 'from-env' },
			home,
			skipProbes: true,
		})
		const anthropic = findDetected(list, 'anthropic')
		expect(anthropic?.apiKey).toBe('from-env')
		expect(anthropic?.source.kind).toBe('env')
		expect(anthropic?.alternatives.length).toBeGreaterThan(0)
	})
})

describe('discoverProviders — local probes', () => {
	it('detects ollama when its probe URL is reachable', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 200 }))
		const list = await discoverProviders({
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
			env: {},
			home: tmpHome(),
			skipProbes: true,
		})
		expect(findDetected(list, 'http')).toBeNull()
	})
})
