import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { runAgent } from '../agents/runAgent.js'
import { MockLLMProvider, registerMock } from '../provider/index.js'
import { testToolset } from '../test-support/toolset.js'
import { defineCapability, dynamicCapability } from './index.js'

registerMock()

describe('host capabilities', () => {
	it('carries related instructions, tools and settings into a real turn', async () => {
		let called = false
		const lookup = testToolset({
			name: 'lookup',
			description: 'Look up an item',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => {
				called = true
				return { success: true, output: 'found' }
			},
		} as never)
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ id: 'c1', name: 'lookup', rawArguments: '{}' }] }, { text: 'done' }],
		})

		const result = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'Find it',
			capabilities: [
				defineCapability({
					id: 'catalog',
					instructions: 'Use the catalog for item lookup.',
					toolsets: [lookup],
					modelSettings: { temperature: 0.3 },
				}),
			],
		})

		expect(called).toBe(true)
		expect(result.output).toBe('done')
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
			'Use the catalog for item lookup.',
		)
		expect(provider.requests[0]?.temperature).toBe(0.3)
	})

	it('resolves a factory once on every invocation, with the same stable id', async () => {
		const observed: string[] = []
		const capability = dynamicCapability('current-user', (context) => {
			observed.push(context.sessionId)
			return defineCapability({
				id: 'current-user',
				instructions: `This run belongs to ${context.sessionId}.`,
			})
		})
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		const first = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'first',
			capabilities: [capability],
		})
		const second = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'second',
			...first.identity,
			capabilities: [capability],
		})

		expect(observed).toEqual([first.identity.sessionId, second.identity.sessionId])
		expect(JSON.stringify(provider.requests[0]?.messages)).toContain(first.identity.sessionId)
		expect(JSON.stringify(provider.requests[1]?.messages)).toContain(second.identity.sessionId)
	})

	it('refuses duplicate ids and changed factory ids before a model call', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'unexpected' }] })
		const base = { provider, model: 'mock-model', prompt: 'hello' }
		await expect(
			runAgent({
				...base,
				capabilities: [defineCapability({ id: 'same' }), defineCapability({ id: 'same' })],
			}),
		).rejects.toThrow('declared twice')
		await expect(
			runAgent({
				...base,
				capabilities: [dynamicCapability('expected', () => ({ id: 'changed' }))],
			}),
		).rejects.toThrow('must keep its declared id')
		expect(provider.requests).toHaveLength(0)
	})

	it('lets explicit run settings override capability settings', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })
		await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'hello',
			temperature: 0,
			capabilities: [defineCapability({ id: 'settings', modelSettings: { temperature: 0.8 } })],
		})
		expect(provider.requests[0]?.temperature).toBe(0)
	})

	it('runs capability guardrails through the turn boundaries', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'private: 1234' }] })
		const result = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'hello',
			capabilities: [
				defineCapability({
					id: 'redaction',
					outputGuardrails: [
						({ output }) => ({
							action: 'rewrite',
							output: output.replace('1234', '[redacted]'),
						}),
					],
				}),
			],
		})
		expect(result.output).toBe('private: [redacted]')
	})

	it('blocks input before model use, including a guardrail passed directly to runAgent', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'unexpected' }] })
		const result = await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'blocked request',
			capabilities: [
				defineCapability({ id: 'input-policy', inputGuardrails: [() => ({ action: 'pass' })] }),
			],
			inputGuardrails: [() => ({ action: 'block', reason: 'not admitted' })],
		})
		expect(provider.requests).toHaveLength(0)
		expect(result.turn.stopReason).toBe('input_guardrail')
		expect(result.turn.lastError).toContain('not admitted')
	})

	it('stops waiting for an aborted run factory before calling the model', async () => {
		const controller = new AbortController()
		let started!: () => void
		const ready = new Promise<void>((resolve) => {
			started = resolve
		})
		const provider = new MockLLMProvider({ turns: [{ text: 'unexpected' }] })
		const pending = runAgent({
			provider,
			model: 'mock-model',
			prompt: 'hello',
			signal: controller.signal,
			capabilities: [
				dynamicCapability('slow', async () => {
					started()
					return await new Promise<never>(() => {})
				}),
			],
		})
		await ready
		controller.abort(new Error('stopped'))
		await expect(pending).rejects.toThrow('stopped')
		expect(provider.requests).toHaveLength(0)
	})
})
