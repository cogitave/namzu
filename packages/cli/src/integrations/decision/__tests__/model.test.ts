import { describe, expect, it } from 'vitest'
import { buildDecisionProviderConfig, maybeCreateDecisionTool } from '../model.js'

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
		expect(await out.getToken()).toBe('one')
		env.MY_TOKEN = 'two'
		expect(await out.getToken()).toBe('two')
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
		expect(await withDefault.getToken()).toBe('tok')
		expect(await without.getToken()).toBe('')
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
		expect(keyless).toEqual({ provider: 'http', url: 'https://d' })
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
