/**
 * A spent prepaid balance or plan allowance reaches the kernel as
 * `usage_limit`. Anthropic words it two ways: a 402 `billing_error`, and an
 * `invalid_request_error` whose message says the credit balance is too low.
 * A burst `rate_limit_error` stays a retryable rate_limit.
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyProviderError } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../client.js'

let server: Server | undefined

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	}
})

async function classified(status: number, type: string, message: string) {
	server = createServer((_req, res) => {
		res.writeHead(status, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ type: 'error', error: { type, message } }))
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
	const provider = new AnthropicProvider({
		apiKey: 'test-key',
		model: 'claude-sonnet-4-5-20250929',
		baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	})
	try {
		for await (const _chunk of provider.chatStream({
			model: 'claude-sonnet-4-5-20250929',
			messages: [{ role: 'user', content: 'hi' }],
		})) {
			// drain
		}
	} catch (error) {
		return classifyProviderError(error)
	}
	throw new Error('expected chatStream to throw')
}

describe('usage_limit mapping in @namzu/anthropic', () => {
	it('maps a 402 billing_error to usage_limit', async () => {
		const result = await classified(
			402,
			'billing_error',
			'There is a billing issue with your account.',
		)
		expect(result.code).toBe('usage_limit')
		expect(result.retryable).toBe(false)
	})

	it('maps an exhausted credit balance to usage_limit', async () => {
		const result = await classified(
			400,
			'invalid_request_error',
			'Your credit balance is too low to access the Anthropic API.',
		)
		expect(result.code).toBe('usage_limit')
		expect(result.retryable).toBe(false)
	})

	it('keeps a burst rate_limit_error retryable', async () => {
		const result = await classified(
			429,
			'rate_limit_error',
			'Number of requests exceeded the rate limit',
		)
		expect(result.code).toBe('rate_limit')
		expect(result.retryable).toBe(true)
	})
})
