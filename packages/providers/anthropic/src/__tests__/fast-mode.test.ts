import type { ChatCompletionParams, TokenUsage } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { ANTHROPIC_CAPABILITIES, AnthropicProvider } from '../client.js'
import { FAST_MODE_BETA, resolveFastMode, supportsFastMode } from '../fast-mode.js'
import type { AnthropicConfig } from '../types.js'

/**
 * Fast mode is `speed: "fast"` on the request, for the models the vendor
 * documents it on. Everything else is refused before transport. The clock is
 * injected so the Opus 4.8 removal date needs no waiting.
 */

const BEFORE_REMOVAL = Date.UTC(2026, 10, 29, 23, 59, 59)
const AT_REMOVAL = Date.UTC(2026, 10, 30)

function harness(config: Partial<AnthropicConfig> = {}) {
	const provider = new AnthropicProvider({ apiKey: 'test-key', ...config })
	const calls: { body: Record<string, unknown>; options?: Record<string, unknown> }[] = []
	const create = vi.fn(async (body: Record<string, unknown>, options?: Record<string, unknown>) => {
		calls.push({ body, options })
		return (async function* () {
			yield {
				type: 'message_start',
				message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } },
			}
			yield {
				type: 'message_delta',
				usage: { output_tokens: 5 },
				delta: { stop_reason: 'end_turn' },
			}
			yield { type: 'message_stop' }
		})()
	})
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: { create },
	}
	return { provider, calls }
}

async function send(
	provider: AnthropicProvider,
	params: Partial<ChatCompletionParams>,
): Promise<TokenUsage[]> {
	const usages: TokenUsage[] = []
	for await (const chunk of provider.chatStream({
		model: 'claude-opus-5-5',
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	} as ChatCompletionParams)) {
		if (chunk.usage) usages.push(chunk.usage)
	}
	return usages
}

describe('fast mode admission', () => {
	it.each([
		'claude-opus-5-5',
		'claude-opus-5-5-20261001',
		'claude-fable-5-2',
		'claude-mythos-5-2',
		'claude-opus-5',
		'claude-opus-4-8',
	])('%s takes speed fast', (model) => {
		expect(supportsFastMode(model, BEFORE_REMOVAL)).toBe(true)
	})

	it.each([
		'claude-opus-4-7',
		'claude-opus-4-6',
		'claude-sonnet-5-5',
		'claude-fable-5-1',
		'claude-fable-5',
		'claude-haiku-5-5',
		'my-gateway-model',
	])('%s does not', (model) => {
		expect(supportsFastMode(model, BEFORE_REMOVAL)).toBe(false)
	})

	it('needs the beta header on the research-preview models only', () => {
		expect(resolveFastMode('claude-opus-5', BEFORE_REMOVAL)).toEqual({
			ok: true,
			beta: FAST_MODE_BETA,
		})
		expect(resolveFastMode('claude-opus-4-8', BEFORE_REMOVAL)).toEqual({
			ok: true,
			beta: FAST_MODE_BETA,
		})
		expect(resolveFastMode('claude-opus-5-5', BEFORE_REMOVAL)).toEqual({ ok: true })
		expect(resolveFastMode('claude-fable-5-2', BEFORE_REMOVAL)).toEqual({ ok: true })
	})

	it('stops admitting opus 4.8 at its removal instant and names the replacement', () => {
		expect(supportsFastMode('claude-opus-4-8', BEFORE_REMOVAL)).toBe(true)
		const verdict = resolveFastMode('claude-opus-4-8', AT_REMOVAL)
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) {
			expect(verdict.reason).toContain('2026-11-30')
			expect(verdict.reason).toContain('claude-opus-5-5')
		}
	})
})

describe('fast mode on the wire', () => {
	it('sends speed only when asked for fast', async () => {
		const { provider, calls } = harness()
		await send(provider, {})
		await send(provider, { speed: 'standard' })
		await send(provider, { speed: 'fast' })
		expect('speed' in calls[0]!.body).toBe(false)
		expect('speed' in calls[1]!.body).toBe(false)
		expect(calls[2]!.body.speed).toBe('fast')
	})

	it('sends no beta header on Opus 5.5 and Fable 5.2', async () => {
		const { provider, calls } = harness()
		await send(provider, { speed: 'fast' })
		await send(provider, { speed: 'fast', model: 'claude-fable-5-2' })
		expect(calls[0]!.options?.headers).toBeUndefined()
		expect(calls[1]!.options?.headers).toBeUndefined()
	})

	it('sends the beta header on Opus 5, merged with the subscription betas on OAuth', async () => {
		const key = harness()
		await send(key.provider, { speed: 'fast', model: 'claude-opus-5' })
		expect(key.calls[0]!.options?.headers).toEqual({ 'anthropic-beta': FAST_MODE_BETA })

		const oauth = harness({ apiKey: undefined, authToken: 'tok' })
		await send(oauth.provider, { speed: 'fast', model: 'claude-opus-5' })
		expect(oauth.calls[0]!.options?.headers).toEqual({
			'anthropic-beta': `claude-code-20250219,oauth-2025-04-20,${FAST_MODE_BETA}`,
		})
	})

	it('keeps a caller-configured beta header when adding its own', async () => {
		const { provider, calls } = harness({ defaultHeaders: { 'Anthropic-Beta': 'x-beta' } })
		await send(provider, { speed: 'fast', model: 'claude-opus-5' })
		expect(calls[0]!.options?.headers).toEqual({ 'anthropic-beta': `x-beta,${FAST_MODE_BETA}` })
	})

	it('refuses an unsupported model locally, before any request', async () => {
		const { provider, calls } = harness()
		await expect(send(provider, { speed: 'fast', model: 'claude-opus-4-7' })).rejects.toMatchObject(
			{
				providerCode: 'fast_mode_unsupported',
				kind: 'bad_request',
			},
		)
		expect(calls).toHaveLength(0)
	})

	it('refuses opus 4.8 after the removal date, using the injected clock', async () => {
		let now = BEFORE_REMOVAL
		const { provider, calls } = harness({ clock: () => now })
		await send(provider, { speed: 'fast', model: 'claude-opus-4-8' })
		expect(calls).toHaveLength(1)
		now = AT_REMOVAL
		await expect(send(provider, { speed: 'fast', model: 'claude-opus-4-8' })).rejects.toThrow(
			/claude-opus-5-5/,
		)
		expect(calls).toHaveLength(1)
	})

	it('refuses fast on a compatible third-party endpoint', async () => {
		const { provider } = harness({ compatibleEndpoint: true, baseURL: 'https://gw.example' })
		await expect(send(provider, { speed: 'fast' })).rejects.toMatchObject({
			providerCode: 'fast_mode_unsupported',
		})
	})

	it('refuses fast on a non-vendor host even without compatibleEndpoint', async () => {
		for (const baseURL of [
			'https://example.services.ai.azure.com/anthropic',
			'https://bedrock-runtime.us-east-1.amazonaws.com',
			'https://gw.example',
		]) {
			const { provider, calls } = harness({ baseURL })
			await expect(send(provider, { speed: 'fast' })).rejects.toMatchObject({
				providerCode: 'fast_mode_unsupported',
			})
			expect(calls).toHaveLength(0)
		}
		const vendor = harness({ baseURL: 'https://api.anthropic.com' })
		await send(vendor.provider, { speed: 'fast' })
		expect(vendor.calls).toHaveLength(1)
	})

	it('reports speed on usage: the response wins, the request is the fallback', async () => {
		const { provider } = harness()
		const usages = await send(provider, { speed: 'fast' })
		expect(usages.every((u) => u.speed === 'fast')).toBe(true)
		const standard = harness()
		expect((await send(standard.provider, {})).every((u) => u.speed === undefined)).toBe(true)
	})
})

describe('request rich-content budget', () => {
	it('declares 100 MiB for the vendor endpoint', () => {
		expect(ANTHROPIC_CAPABILITIES.maxRequestRichContentBytes).toBe(100 * 1024 * 1024)
		expect(new AnthropicProvider({ apiKey: 'k' }).capabilities.maxRequestRichContentBytes).toBe(
			100 * 1024 * 1024,
		)
		expect(
			new AnthropicProvider({ apiKey: 'k', baseURL: 'https://api.anthropic.com' }).capabilities
				.maxRequestRichContentBytes,
		).toBe(100 * 1024 * 1024)
	})

	it('declares nothing behind another base URL or a compatible endpoint', () => {
		const proxied = new AnthropicProvider({ apiKey: 'k', baseURL: 'https://proxy.example/v1' })
		expect(proxied.capabilities.maxRequestRichContentBytes).toBeUndefined()
		expect(proxied.capabilities.supportsVision).toBe(true)
		const compatible = new AnthropicProvider({
			apiKey: 'k',
			compatibleEndpoint: true,
		})
		expect(compatible.capabilities.maxRequestRichContentBytes).toBeUndefined()
	})
})
