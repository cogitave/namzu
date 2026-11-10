import { describe, expect, it, vi } from 'vitest'
import {
	buildDecisionProviderConfig,
	maybeCreateDecisionModel,
	maybeCreateDecisionTool,
} from '../model.js'

describe('buildDecisionProviderConfig', () => {
	it('maps an azure block and reads the token from the named variable at call time', async () => {
		const env: NodeJS.ProcessEnv = { MY_TOKEN: 'one' }
		const out = buildDecisionProviderConfig(
			{ provider: 'azure', endpoint: 'https://x', deployment: 'd', tokenEnv: 'MY_TOKEN' },
			env,
		)
		expect(out.provider).toBe('azure')
		if (out.provider !== 'azure') return
		expect(out.endpoint).toBe('https://x')
		expect(out.deployment).toBe('d')
		expect(await out.getToken?.()).toBe('one')
		env.MY_TOKEN = 'two'
		expect(await out.getToken?.()).toBe('two')
	})

	it('maps an azure key variable to an api key read at call time, and sends no token', () => {
		const env: NodeJS.ProcessEnv = { MY_KEY: 'k1' }
		const out = buildDecisionProviderConfig(
			{ provider: 'azure', endpoint: 'https://x', deployment: 'd', apiKeyEnv: 'MY_KEY' },
			env,
		)
		if (out.provider !== 'azure') throw new Error('azure')
		expect(out.getToken).toBeUndefined()
		expect(out.getApiKey?.()).toBe('k1')
		env.MY_KEY = 'k2'
		expect(out.getApiKey?.()).toBe('k2')
	})

	it('defaults the azure token variable and yields an empty token when unset', async () => {
		const withDefault = buildDecisionProviderConfig(
			{ provider: 'azure', endpoint: 'e', deployment: 'd' },
			{ AZURE_FOUNDRY_TOKEN: 'tok' },
		)
		const without = buildDecisionProviderConfig(
			{ provider: 'azure', endpoint: 'e', deployment: 'd' },
			{},
		)
		if (withDefault.provider !== 'azure' || without.provider !== 'azure') throw new Error('azure')
		expect(await withDefault.getToken?.()).toBe('tok')
		expect(await without.getToken?.()).toBe('')
	})

	it('maps an http block, with a key only when apiKeyEnv is set', () => {
		const keyed = buildDecisionProviderConfig(
			{ provider: 'http', url: 'https://d', model: 'm', apiKeyEnv: 'K' },
			{ K: 'secret' },
		)
		expect(keyed).toMatchObject({
			provider: 'http',
			url: 'https://d',
			model: 'm',
			apiKey: 'secret',
		})
		const keyless = buildDecisionProviderConfig({ provider: 'http', url: 'https://d' }, { K: 's' })
		expect(keyless).toMatchObject({ provider: 'http', url: 'https://d' })
		expect(keyless).not.toHaveProperty('apiKey')
	})
})

describe('maybeCreateDecisionTool', () => {
	it('mounts nothing without config', () => {
		expect(maybeCreateDecisionTool(undefined, {})).toBeUndefined()
	})

	it('builds the decide tool from a block', () => {
		const tool = maybeCreateDecisionTool({ provider: 'http', url: 'https://d' }, {})
		expect(tool?.name).toBe('decide')
	})
})

describe('maybeCreateDecisionModel', () => {
	it('is undefined without a decision block', () => {
		expect(maybeCreateDecisionModel(undefined, {})).toBeUndefined()
	})

	it('returns the model itself, not the fail-open tool', () => {
		const model = maybeCreateDecisionModel({ provider: 'http', url: 'http://localhost:1/d' }, {})
		expect(typeof model?.yesno).toBe('function')
		expect(typeof model?.score).toBe('function')
	})
})

describe('NAMZU_NO_DECISION', () => {
	const cfg = { provider: 'http', url: 'https://d' } as const

	it('builds the model and the tool without it', () => {
		expect(maybeCreateDecisionModel(cfg, {})).toBeDefined()
		expect(maybeCreateDecisionTool(cfg, {})).toBeDefined()
	})

	it('builds neither when it is 1, whatever the config says', () => {
		const off = { NAMZU_NO_DECISION: '1' }
		expect(maybeCreateDecisionModel(cfg, off)).toBeUndefined()
		expect(maybeCreateDecisionTool(cfg, off)).toBeUndefined()
	})

	it('is a switch for 1 only, so a stray value does not silently disable it', () => {
		expect(maybeCreateDecisionModel(cfg, { NAMZU_NO_DECISION: '0' })).toBeDefined()
		expect(maybeCreateDecisionModel(cfg, { NAMZU_NO_DECISION: '' })).toBeDefined()
	})
})

describe('the key saved when the model was connected', () => {
	const azure = { provider: 'azure', endpoint: 'https://x', deployment: 'd' } as const

	it('is sent as the api key, read once and only when a call is made', () => {
		const readStoredKey = vi.fn(() => 'stored-key')
		const out = buildDecisionProviderConfig(azure, {}, { readStoredKey })
		if (out.provider !== 'azure') throw new Error('azure')
		expect(out.getToken).toBeUndefined()
		expect(out.getApiKey?.()).toBe('stored-key')
		expect(out.getApiKey?.()).toBe('stored-key')
		expect(readStoredKey).toHaveBeenCalledTimes(1)
	})

	it('loses to a variable the config names', () => {
		const out = buildDecisionProviderConfig(
			{ ...azure, apiKeyEnv: 'MY_KEY' },
			{ MY_KEY: 'from-env' },
			{ readStoredKey: () => 'stored-key' },
		)
		if (out.provider !== 'azure') throw new Error('azure')
		expect(out.getApiKey?.()).toBe('from-env')
	})

	it('leaves a config that names a token variable on the token path', async () => {
		const out = buildDecisionProviderConfig(
			{ ...azure, tokenEnv: 'T' },
			{ T: 'tok' },
			{ readStoredKey: () => 'stored-key' },
		)
		if (out.provider !== 'azure') throw new Error('azure')
		expect(out.getApiKey).toBeUndefined()
		expect(await out.getToken?.()).toBe('tok')
	})

	it('goes to the token path when no key is saved', async () => {
		const out = buildDecisionProviderConfig(
			azure,
			{ AZURE_FOUNDRY_TOKEN: 'tok' },
			{
				readStoredKey: () => null,
			},
		)
		if (out.provider !== 'azure') throw new Error('azure')
		expect(await out.getToken?.()).toBe('tok')
	})

	it('is sent to an http server as a bearer token, and nothing is sent when none is saved', async () => {
		const seen: Array<string | null> = []
		const fetchFn = (async (_url: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get('authorization'))
			return new Response('{}')
		}) as typeof fetch
		const keyed = buildDecisionProviderConfig(
			{ provider: 'http', url: 'http://h' },
			{},
			{ readStoredKey: () => 'k', fetch: fetchFn },
		)
		const keyless = buildDecisionProviderConfig(
			{ provider: 'http', url: 'http://h' },
			{},
			{ readStoredKey: () => null, fetch: fetchFn },
		)
		if (keyed.provider !== 'http' || keyless.provider !== 'http') throw new Error('http')
		await keyed.fetch?.('http://h', {})
		await keyless.fetch?.('http://h', {})
		expect(seen).toEqual(['Bearer k', null])
	})

	it('is not read at all when the kill switch is set', () => {
		const readStoredKey = vi.fn(() => 'k')
		expect(
			maybeCreateDecisionModel(azure, { NAMZU_NO_DECISION: '1' }, { readStoredKey }),
		).toBeUndefined()
		expect(readStoredKey).not.toHaveBeenCalled()
	})
})

describe('the saved key and the address it belongs to', () => {
	it('is asked for with the address the block names, and a key bound elsewhere is not sent', async () => {
		const asked: string[] = []
		const seen: Array<string | null> = []
		const fetchFn = (async (_url: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get('authorization'))
			return new Response('{}')
		}) as typeof fetch
		const out = buildDecisionProviderConfig(
			{ provider: 'http', url: 'http://other' },
			{},
			{
				readStoredKey: (address) => {
					asked.push(address)
					return address === 'http://saved' ? 'k' : null
				},
				fetch: fetchFn,
			},
		)
		if (out.provider !== 'http') throw new Error('http')
		await out.fetch?.('http://other', {})
		expect(asked).toEqual(['http://other'])
		expect(seen).toEqual([null])
	})

	it('goes to the token path for an azure endpoint the key was not saved with', () => {
		const out = buildDecisionProviderConfig(
			{ provider: 'azure', endpoint: 'https://b', deployment: 'd' },
			{},
			{ readStoredKey: (address) => (address === 'https://a' ? 'k' : null) },
		)
		if (out.provider !== 'azure') throw new Error('azure')
		expect(out.getApiKey).toBeUndefined()
		expect(out.getToken).toBeDefined()
	})
})
