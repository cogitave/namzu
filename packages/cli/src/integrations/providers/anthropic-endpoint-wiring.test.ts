import { afterEach, describe, expect, it, vi } from 'vitest'

import { constructProvider } from '../../tui/agent.js'
import { ensureRegistered } from './register.js'

afterEach(() => vi.unstubAllEnvs())

type Seen = { config: { authToken?: string; apiKey?: string; baseURL?: string } }
const configOf = (provider: unknown) => (provider as Seen).config

describe('an Anthropic-compatible endpoint from the standard variables', () => {
	it('sends the bearer token to that endpoint and nothing saved', async () => {
		await ensureRegistered('anthropic')
		vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.test/anthropic')
		vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'third-party-token')
		const saved = { id: 'anthropic', apiKey: 'sk-ant-oat-saved-signin' } as never
		const config = configOf(constructProvider('anthropic', saved, 'deepseek-flash[1m]'))
		expect(config.authToken).toBe('third-party-token')
		expect(config.baseURL).toBe('https://api.example.test/anthropic')
		expect(config.apiKey).toBeUndefined()
	})

	it('never sends a saved sign-in to another host when no variable names a credential', async () => {
		await ensureRegistered('anthropic')
		vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.test/anthropic')
		vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '')
		vi.stubEnv('ANTHROPIC_API_KEY', '')
		const saved = { id: 'anthropic', apiKey: 'sk-ant-oat-saved-signin' } as never
		// Does not throw: the saved sign-in keeps going to the vendor's own host.
		const config = configOf(constructProvider('anthropic', saved, 'claude-sonnet-4-5'))
		expect(config.authToken).toBe('sk-ant-oat-saved-signin')
		expect(config.baseURL).toBeUndefined()
	})

	it('marks the driver as talking to a compatible endpoint', async () => {
		await ensureRegistered('anthropic')
		vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.example.test/anthropic')
		vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'third-party-token')
		const config = configOf(constructProvider('anthropic', null, 'deepseek-flash')) as {
			compatibleEndpoint?: boolean
		}
		expect(config.compatibleEndpoint).toBe(true)
	})

	it('leaves saved credentials exactly as they were when no base URL is set', async () => {
		await ensureRegistered('anthropic')
		vi.stubEnv('ANTHROPIC_BASE_URL', '')
		vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ignored-without-a-base-url')
		const oauth = configOf(
			constructProvider(
				'anthropic',
				{ id: 'anthropic', apiKey: 'sk-ant-oat-saved' } as never,
				'claude-sonnet-4-5',
			),
		)
		expect(oauth.authToken).toBe('sk-ant-oat-saved')
		expect(oauth.baseURL).toBeUndefined()
		const key = configOf(
			constructProvider(
				'anthropic',
				{ id: 'anthropic', apiKey: 'sk-ant-api-test' } as never,
				'claude-sonnet-4-5',
			),
		)
		expect(key.apiKey).toBe('sk-ant-api-test')
		expect(key.authToken).toBeUndefined()
	})

	it('keeps a vendor-host base URL on the saved credential', async () => {
		await ensureRegistered('anthropic')
		vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')
		const config = configOf(
			constructProvider(
				'anthropic',
				{ id: 'anthropic', apiKey: 'sk-ant-api-test' } as never,
				'claude-sonnet-4-5',
			),
		)
		expect(config.apiKey).toBe('sk-ant-api-test')
		expect(config.baseURL).toBe('https://api.anthropic.com')
	})
})
