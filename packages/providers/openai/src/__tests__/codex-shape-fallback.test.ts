import type { ChatCompletionParams } from '@namzu/sdk'
import OpenAI from 'openai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetSubscriptionDowngrade } from '../codex.js'
import { CodexProvider } from '../index.js'

const finishedStream = () =>
	(async function* () {
		yield { type: 'response.completed', response: { id: 'resp_fixture', output: [], usage: {} } }
	})()

function badRequest(message: string): Error {
	return OpenAI.APIError.generate(400, { message }, message, new Headers()) as Error
}

type Call = [Record<string, unknown>, { headers?: Record<string, string> }]

function setup(create: (...args: unknown[]) => Promise<unknown>) {
	const provider = new CodexProvider({
		accessToken: 'access',
		accountId: 'account',
		model: 'gpt-fixture',
	})
	const fn = vi.fn(create)
	;(provider as unknown as { client: { responses: { create: unknown } } }).client.responses = {
		create: fn,
	}
	const run = async () => {
		for await (const _ of provider.chatStream(PARAMS)) {
			// drain
		}
	}
	return { fn, run, calls: () => fn.mock.calls as unknown as Call[] }
}

const PARAMS: ChatCompletionParams = {
	model: 'gpt-fixture',
	cacheKey: 'conv-1',
	messages: [
		{ role: 'system', content: 'Standing.' },
		{ role: 'user', content: 'hello' },
		{ role: 'system', content: 'Step note.' },
	],
}

const hasDeveloper = (body: Record<string, unknown>) =>
	(body.input as Array<{ role?: string }>).some((item) => item.role === 'developer')

describe('subscription route shape fallback', () => {
	beforeEach(() => resetSubscriptionDowngrade())

	it('sends the new shape on success', async () => {
		const { run, calls } = setup(async () => finishedStream())
		await run()
		expect(calls()).toHaveLength(1)
		const [body, opts] = calls()[0] as Call
		expect(body.instructions).toBe('Standing.')
		expect(hasDeveloper(body)).toBe(true)
		expect(body.prompt_cache_key).toBe('conv-1')
		expect(opts.headers?.session_id).toBe('conv-1')
	})

	it('resends once in the old shape after a 400 naming the developer role, and remembers it', async () => {
		let n = 0
		const { run, calls } = setup(async () => {
			if (n++ === 0) throw badRequest("Invalid value: 'developer'. Unknown input[1].role")
			return finishedStream()
		})
		await run()
		expect(calls()).toHaveLength(2)
		const [body, opts] = calls()[1] as Call
		expect(body.instructions).toBe('Standing.\n\nStep note.')
		expect(hasDeveloper(body)).toBe(false)
		expect(opts.headers?.session_id).toBeUndefined()
		expect(body.prompt_cache_key).toBe('conv-1')

		await run()
		expect(calls()).toHaveLength(3)
		const [later, laterOpts] = calls()[2] as Call
		expect(later.instructions).toBe('Standing.\n\nStep note.')
		expect(hasDeveloper(later)).toBe(false)
		expect(laterOpts.headers?.session_id).toBeUndefined()
	})

	it('drops prompt_cache_key too when the error names it', async () => {
		let n = 0
		const { run, calls } = setup(async () => {
			if (n++ === 0) throw badRequest('Unknown parameter: prompt_cache_key')
			return finishedStream()
		})
		await run()
		expect((calls()[1] as Call)[0].prompt_cache_key).toBeUndefined()
	})

	it('does not retry an unrelated 400', async () => {
		const { run, calls } = setup(async () => {
			throw badRequest('context window exceeded')
		})
		await expect(run()).rejects.toThrow()
		expect(calls()).toHaveLength(1)
		await expect(run()).rejects.toThrow()
		expect(calls()).toHaveLength(2)
		expect(hasDeveloper((calls()[1] as Call)[0])).toBe(true)
	})

	it('does not retry when the refused shape fails twice, or on another status', async () => {
		const { run, calls } = setup(async () => {
			throw badRequest('bad developer role')
		})
		await expect(run()).rejects.toThrow()
		expect(calls()).toHaveLength(2)
		await expect(run()).rejects.toThrow()
		expect(calls()).toHaveLength(3)
	})

	it('does not retry a 500 that mentions the role', async () => {
		const { run, calls } = setup(async () => {
			throw OpenAI.APIError.generate(500, { message: 'role' }, 'role', new Headers())
		})
		await expect(run()).rejects.toThrow()
		expect(calls()).toHaveLength(1)
	})
})
