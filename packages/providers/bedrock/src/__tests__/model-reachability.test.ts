import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { BedrockProvider } from '../client.js'
import { assertModelReachable } from '../model-reachability.js'

/**
 * This driver speaks Converse with ARN-versioned model ids. The current Claude
 * generation is served by a different Bedrock integration whose ids carry no
 * version suffix, and pointing this wire at one produced an opaque AWS
 * validation error naming neither the cause nor the remedy.
 */

describe('model ids this wire can serve', () => {
	const reachable = [
		'anthropic.claude-sonnet-4-5-20250929-v1:0',
		'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
		'eu.anthropic.claude-opus-4-5-20251101-v1:0',
		'global.anthropic.claude-opus-4-6-v1',
		'apac.anthropic.claude-sonnet-4-20250514-v1:0',
		'anthropic.claude-haiku-4-5-20251001-v1:0',
	]

	for (const model of reachable) {
		it(`accepts ${model}`, () => {
			expect(() => assertModelReachable(model)).not.toThrow()
		})
	}

	const unreachable = [
		'anthropic.claude-opus-5',
		'anthropic.claude-sonnet-5',
		'anthropic.claude-fable-5',
		'anthropic.claude-opus-4-8',
		'anthropic.claude-opus-4-7',
		'us.anthropic.claude-opus-5',
	]

	for (const model of unreachable) {
		it(`refuses ${model} and says why`, () => {
			expect(() => assertModelReachable(model)).toThrow(/cannot reach/)
			expect(() => assertModelReachable(model)).toThrow(/Converse API/)
		})
	}

	it('leaves a non-Claude model alone', () => {
		// This driver serves whatever Bedrock serves. The check is about one
		// vendor's id scheme, not about policing the catalogue.
		expect(() => assertModelReachable('amazon.nova-pro-v1:0')).not.toThrow()
		expect(() => assertModelReachable('meta.llama3-70b-instruct-v1:0')).not.toThrow()
	})

	it('accepts an unknown versioned Claude id', () => {
		// A model this file has never heard of passes as long as its id has
		// the shape this wire carries. A list that must be edited for every
		// new model is a list that is wrong before anyone reads it.
		expect(() => assertModelReachable('anthropic.claude-sonnet-9-20991231-v1:0')).not.toThrow()
	})
})

describe('the driver refuses before it calls AWS', () => {
	it('throws on an unreachable model with no credentials in play', async () => {
		const provider = new BedrockProvider({ region: 'us-east-1' } as never)

		await expect(async () => {
			for await (const _ of provider.chatStream({
				model: 'anthropic.claude-opus-5',
				messages: [{ role: 'user', content: 'hi' }],
			} as ChatCompletionParams)) {
				// drain
			}
		}).rejects.toThrow(/cannot reach "anthropic\.claude-opus-5"/)
	})
})
