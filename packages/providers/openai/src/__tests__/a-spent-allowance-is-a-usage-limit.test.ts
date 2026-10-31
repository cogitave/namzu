/**
 * A spent allowance reaches the kernel as `usage_limit`, not as a burst
 * limit that would be retried. The OpenAI wire says it in `error.code`
 * (`insufficient_quota`); the ChatGPT-backed Codex wire is understood by its
 * documented plan-limit identifier `usage_limit_reached` in `error.type`.
 * The Codex body shape is mapped from that documented identifier and has not
 * been observed from a live account here.
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyProviderError } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../client.js'
import { CodexProvider } from '../codex.js'

let server: Server | undefined

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	}
})

async function endpoint(status: number, body: unknown): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(status, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify(body))
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function failure(provider: {
	chatStream(p: { model: string; messages: unknown[] }): AsyncIterable<unknown>
}): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
		})) {
			// drain
		}
	} catch (error) {
		return error
	}
	throw new Error('expected chatStream to throw')
}

describe('usage_limit mapping in @namzu/openai', () => {
	it('maps a 429 insufficient_quota to usage_limit, not a retryable rate_limit', async () => {
		const baseURL = `${await endpoint(429, {
			error: {
				message: 'You exceeded your current quota, please check your plan.',
				type: 'insufficient_quota',
				code: 'insufficient_quota',
			},
		})}/v1`
		const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'm', baseURL, maxRetries: 0 })
		const error = await failure(provider)
		expect(error).toMatchObject({
			kind: 'throttle',
			status: 429,
			providerCode: 'insufficient_quota',
		})
		const classified = classifyProviderError(error)
		expect(classified.code).toBe('usage_limit')
		expect(classified.retryable).toBe(false)
	})

	it('keeps an ordinary 429 a retryable rate_limit', async () => {
		const baseURL = `${await endpoint(429, {
			error: {
				message: 'Rate limit reached',
				type: 'rate_limit_error',
				code: 'rate_limit_exceeded',
			},
		})}/v1`
		const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'm', baseURL, maxRetries: 0 })
		const classified = classifyProviderError(await failure(provider))
		expect(classified.code).toBe('rate_limit')
		expect(classified.retryable).toBe(true)
	})

	it('maps the Codex plan-limit type to usage_limit', async () => {
		const baseURL = await endpoint(429, {
			error: {
				type: 'usage_limit_reached',
				message: 'The usage limit has been reached',
				plan_type: 'plus',
				resets_in_seconds: 3600,
			},
		})
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
			baseURL,
			maxRetries: 0,
		} as ConstructorParameters<typeof CodexProvider>[0])
		const error = await failure(provider)
		expect(error).toMatchObject({
			kind: 'throttle',
			status: 429,
			providerCode: 'usage_limit_reached',
		})
		expect(classifyProviderError(error).code).toBe('usage_limit')
	})
})
