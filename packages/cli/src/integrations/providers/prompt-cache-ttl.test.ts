import { afterEach, describe, expect, it } from 'vitest'

import { constructProvider } from '../../tui/agent.js'
import { promptCacheTtl, setPromptCacheTtl } from './prompt-cache-ttl.js'
import { ensureRegistered } from './register.js'

afterEach(() => setPromptCacheTtl(undefined))

describe('the prompt cache lifetime setting', () => {
	it('is unset until a session sets it', () => {
		expect(promptCacheTtl()).toBeUndefined()
		setPromptCacheTtl('1h')
		expect(promptCacheTtl()).toBe('1h')
	})

	it('reaches the Anthropic provider and leaves the default alone otherwise', async () => {
		await ensureRegistered('anthropic')
		const detected = { id: 'anthropic', apiKey: 'sk-ant-api-test' } as never
		const seen: unknown[] = []
		const build = () => {
			const provider = constructProvider('anthropic', detected, 'claude-sonnet-4-5')
			seen.push(
				(provider as unknown as { config: { promptCacheTtl?: string } }).config.promptCacheTtl,
			)
		}
		build()
		setPromptCacheTtl('1h')
		build()
		expect(seen).toEqual([undefined, '1h'])
	})
})
