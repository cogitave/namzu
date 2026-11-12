import { afterEach, describe, expect, it } from 'vitest'

import { ProviderRequestError } from '../../provider/errors.js'
import type { TokenUsage } from '../../types/common/index.js'
import {
	GENAI_NON_CONVENTION_NAMES,
	GENAI_OPERATION,
	GENAI_SEMCONV_ATTRIBUTES,
	GENAI_SEMCONV_SCHEMA_URL,
	GENAI_SEMCONV_VERSION,
	agentRunAttributes,
	chatStartAttributes,
	chatUsageAttributes,
	errorTypeAttributes,
	genAiConventionsEnabled,
	genAiErrorType,
	genAiProviderName,
	setGenAiConventions,
	toolCallAttributes,
} from '../genai.js'

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
	...over,
})

afterEach(() => setGenAiConventions(true))

describe('the pin', () => {
	it('names one released version and its schema URL', () => {
		expect(GENAI_SEMCONV_VERSION).toBe('1.41.1')
		expect(GENAI_SEMCONV_SCHEMA_URL).toBe('https://opentelemetry.io/schemas/1.41.1')
	})

	it('lists no name twice, and keeps gen_ai.system outside the convention list', () => {
		expect(new Set(GENAI_SEMCONV_ATTRIBUTES).size).toBe(GENAI_SEMCONV_ATTRIBUTES.length)
		for (const name of GENAI_NON_CONVENTION_NAMES) {
			expect(GENAI_SEMCONV_ATTRIBUTES).not.toContain(name)
		}
	})
})

describe('provider names', () => {
	it('maps only the ids with a value the convention lists', () => {
		expect(genAiProviderName('anthropic')).toBe('anthropic')
		expect(genAiProviderName('bedrock')).toBe('aws.bedrock')
		expect(genAiProviderName('google')).toBe('gcp.gen_ai')
		expect(genAiProviderName('openai')).toBe('openai')
		expect(genAiProviderName('codex')).toBe('openai')
		expect(genAiProviderName('deepseek')).toBe('deepseek')
	})

	it('leaves out the ones it has no value for, and never invents one', () => {
		for (const id of [
			'ollama',
			'lmstudio',
			'openrouter',
			'http',
			'zen',
			'zen-go',
			'mock',
			'',
			undefined,
		]) {
			expect(genAiProviderName(id)).toBeUndefined()
		}
	})
})

describe('error.type', () => {
	it('is the kind of a classified provider failure', () => {
		const err = new ProviderRequestError({
			kind: 'throttle',
			providerId: 'anthropic',
			message: 'slow down',
		} as never)
		expect(genAiErrorType(err)).toBe('throttle')
	})

	it('is the class name of an exception, and the convention fallback otherwise', () => {
		expect(genAiErrorType(new RangeError('x'))).toBe('RangeError')
		expect(genAiErrorType(new Error('x'))).toBe('_OTHER')
		expect(genAiErrorType('a string')).toBe('_OTHER')
		expect(genAiErrorType(undefined)).toBe('_OTHER')
	})
})

describe('the attribute builders', () => {
	it('an agent run states the operation, and the provider only when it maps', () => {
		expect(agentRunAttributes('openai')).toEqual({
			'gen_ai.operation.name': GENAI_OPERATION.INVOKE_AGENT,
			'gen_ai.provider.name': 'openai',
		})
		expect(agentRunAttributes('ollama')).toEqual({ 'gen_ai.operation.name': 'invoke_agent' })
	})

	it('a model call states streaming, and the provider only when it maps', () => {
		expect(chatStartAttributes('anthropic')).toEqual({
			'gen_ai.provider.name': 'anthropic',
			'gen_ai.request.stream': true,
		})
		expect(chatStartAttributes('mock')).toEqual({ 'gen_ai.request.stream': true })
	})

	it('usage states only counts the driver reported', () => {
		expect(chatUsageAttributes(usage())).toEqual({})
		expect(
			chatUsageAttributes(usage({ cachedTokens: 3, cacheWriteTokens: 4, reasoningTokens: 2 })),
		).toEqual({
			'gen_ai.usage.cache_read.input_tokens': 3,
			'gen_ai.usage.cache_creation.input_tokens': 4,
			'gen_ai.usage.reasoning.output_tokens': 2,
		})
		expect(chatUsageAttributes(usage({ reasoningTokens: 0 }))).toEqual({})
	})

	it('a tool call states its operation; a failure states its class', () => {
		expect(toolCallAttributes()).toEqual({ 'gen_ai.operation.name': 'execute_tool' })
		expect(errorTypeAttributes('timeout')).toEqual({ 'error.type': 'timeout' })
	})

	it('off, every builder returns nothing', () => {
		setGenAiConventions(false)
		expect(genAiConventionsEnabled()).toBe(false)
		expect(agentRunAttributes('openai')).toEqual({})
		expect(chatStartAttributes('openai')).toEqual({})
		expect(chatUsageAttributes(usage({ cachedTokens: 3 }))).toEqual({})
		expect(toolCallAttributes()).toEqual({})
		expect(errorTypeAttributes('x')).toEqual({})
	})

	it('is on by default', () => {
		expect(genAiConventionsEnabled()).toBe(true)
	})
})
