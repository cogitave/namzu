import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import { runAgent } from '../runAgent.js'

/**
 * `drainQuery` takes eleven required parameters, four of which throw when
 * missing. That is right for a kernel and wrong for the first thing anybody
 * writes — and the proof was in this repo, where the eval suites, the test
 * files and the CLI each hand-assembled the same block.
 *
 * These pin the two things a front door has to get right: that the short form
 * works at all, and that the identity it invents comes back, because a
 * generated session that a caller cannot recover is a conversation that
 * silently restarts on turn two.
 */

registerMock()

describe('running an agent through the front door', () => {
	it('runs from a provider, a model and a prompt', async () => {
		const { output, run } = await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'four' }] }),
			model: 'mock-model',
			prompt: 'What is 2 + 2?',
		})

		expect(output).toBe('four')
		expect(run.status).toBe('completed')
		expect(run.stopReason).toBe('end_turn')
	})

	it('hands back the identity it generated, so a second turn can continue', async () => {
		const first = await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'noted' }] }),
			model: 'mock-model',
			prompt: 'My name is Ada.',
		})

		expect(first.identity.sessionId).toBeTruthy()
		expect(first.identity.tenantId).toBeTruthy()

		const second = await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'Ada' }] }),
			model: 'mock-model',
			prompt: 'What is my name?',
			...first.identity,
		})

		// The same session, not a new one that happens to work.
		expect(second.identity).toEqual(first.identity)
	})

	it('generates a distinct identity per run when none is given', async () => {
		const a = await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'a' }] }),
			model: 'mock-model',
			prompt: 'x',
		})
		const b = await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'b' }] }),
			model: 'mock-model',
			prompt: 'y',
		})

		expect(a.identity.sessionId).not.toBe(b.identity.sessionId)
	})

	it('carries prior messages when the prompt is a history', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'Ada' }] })

		await runAgent({
			provider,
			model: 'mock-model',
			prompt: [
				{ role: 'user', content: 'My name is Ada.' },
				{ role: 'assistant', content: 'Noted.' },
				{ role: 'user', content: 'What is my name?' },
			] as never,
		})

		const sent = provider.requests[0]?.messages.map((m) => m.content) ?? []
		expect(sent).toContain('My name is Ada.')
		expect(sent).toContain('What is my name?')
	})

	it('passes instructions through as the system prompt', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })

		await runAgent({
			provider,
			model: 'mock-model',
			prompt: 'hello',
			instructions: 'You only answer in haiku.',
		})

		const system = JSON.stringify(provider.requests[0]?.messages ?? [])
		expect(system).toContain('You only answer in haiku.')
	})

	it('runs tools when given a registry', async () => {
		const tools = new ToolRegistry()
		let ran = false
		tools.register({
			name: 'ping',
			description: 'pings',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => {
				ran = true
				return { success: true, output: 'pong' }
			},
		} as never)

		const { output } = await runAgent({
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ id: 'c1', name: 'ping', rawArguments: '{}' }] }, { text: 'done' }],
			}),
			model: 'mock-model',
			prompt: 'ping it',
			tools,
		})

		expect(ran).toBe(true)
		expect(output).toBe('done')
	})

	it('caps a runaway loop on its own default', async () => {
		const tools = new ToolRegistry()
		tools.register({
			name: 'again',
			description: 'always asks for more',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'and again' }),
		} as never)

		// The point of a default budget is that a caller who set none is still
		// protected. Two iterations here rather than the default sixteen, so
		// the test pins the mechanism without paying for it.
		const { run } = await runAgent({
			provider: new MockLLMProvider({
				turns: Array.from({ length: 10 }, () => ({
					toolCalls: [{ id: 'c', name: 'again', rawArguments: '{}' }],
				})),
			}),
			model: 'mock-model',
			prompt: 'loop',
			tools,
			maxIterations: 2,
		})

		expect(run.currentIteration).toBeLessThanOrEqual(2)
	})
})
