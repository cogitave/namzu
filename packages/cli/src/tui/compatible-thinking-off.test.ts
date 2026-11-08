import { describe, expect, it } from 'vitest'

import { compatibleThinkingOff } from './agent.js'

describe('the switch a compatible endpoint has for no reasoning', () => {
	it('is none for OpenAI itself, for an unknown host and for no base URL', () => {
		expect(compatibleThinkingOff(undefined)).toBeUndefined()
		expect(compatibleThinkingOff('https://api.openai.com/v1')).toBeUndefined()
		expect(compatibleThinkingOff('not a url')).toBeUndefined()
		expect(compatibleThinkingOff('https://gateway.example.test/v1')?.('some-model')).toBeUndefined()
	})

	it('is a thinking object for DeepSeek, by host or by model id', () => {
		expect(compatibleThinkingOff('https://api.deepseek.com/v1')?.('deepseek-chat')).toEqual({
			thinking: { type: 'disabled' },
		})
		expect(compatibleThinkingOff('https://gateway.example.test/v1')?.('deepseek-v4')).toEqual({
			thinking: { type: 'disabled' },
		})
	})

	it('is a template flag for Qwen and DashScope', () => {
		expect(compatibleThinkingOff('https://dashscope.example.test/v1')?.('anything')).toEqual({
			enable_thinking: false,
		})
		expect(compatibleThinkingOff('https://gateway.example.test/v1')?.('qwen3-32b')).toEqual({
			enable_thinking: false,
		})
	})
})
