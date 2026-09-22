import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { frameServerResult } from '../../connector/mcp/adapter.js'
import { MockLLMProvider, registerMock } from '../../provider/index.js'
import { ToolRegistry } from '../../registry/index.js'
import type { Message } from '../../types/message/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { runAgent } from '../runAgent.js'

/**
 * The half #426 left open and #427 finished: a screen reaches a registry the
 * TURN did not build.
 *
 * Until this existed, `resultGuardrails` was a registry-construction option
 * and nothing else, and the shipped CLI builds `new ToolRegistry()` — so the
 * screen had the reachability of a feature flag with no flag, and a default
 * built on it would have been a default no operator could turn off.
 *
 * These drive `runAgent`, because the claim is about a turn rather than about
 * the registry: the tool is the host's, the registry is the host's, and what
 * changes is what the turn asks for.
 */

registerMock()

const QUERY = 'the deployment rollback procedure for the payments service'

/**
 * A tool that answers with the request.
 *
 * Named a server, it is a connected server's tool: `provenance` AND the frame
 * the adapter applies, because in the product the two arrive together and it
 * is the frame the default scope reads. Called without one, it is a tool of
 * this process's own, which frames nothing.
 */
function echoingTool(server?: string): ToolDefinition {
	return {
		name: 'lookup',
		description: 'Looks something up.',
		inputSchema: z.object({ query: z.string() }),
		async execute(input) {
			const { query } = input as { query: string }
			const result = { success: true, output: query }
			return server === undefined ? result : frameServerResult(result, server, 'lookup')
		},
		...(server === undefined ? {} : { provenance: { server, readOnlyHintTrusted: false } }),
	}
}

function hostRegistry(...tools: readonly ToolDefinition[]): ToolRegistry {
	const registry = new ToolRegistry()
	for (const tool of tools) registry.register(tool)
	return registry
}

function provider(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'lookup', args: { query: QUERY } }] }, { text: 'done' }],
	})
}

/** What the model was handed in place of the tool's answer. */
function toolMessages(provider: MockLLMProvider): string {
	return JSON.stringify(
		(provider.requests[1]?.messages ?? []).filter((message: Message) => message.role === 'tool'),
	)
}

describe('a turn screens a registry it did not build', () => {
	it('refuses a connected result that restates the request', async () => {
		const mock = provider()

		await runAgent({
			provider: mock,
			model: 'mock-model',
			prompt: 'find the rollback procedure',
			tools: hostRegistry(echoingTool('weather-co')),
		})

		expect(toolMessages(mock)).toContain('tool-result-correspondence')
	})

	it('leaves a host tool alone, because its answer may legitimately be the request', async () => {
		// The web_fetch case, at the turn level: a page whose body IS the URL.
		const mock = provider()

		await runAgent({
			provider: mock,
			model: 'mock-model',
			prompt: 'find the rollback procedure',
			tools: hostRegistry(echoingTool()),
		})

		expect(toolMessages(mock)).toContain(QUERY)
	})

	it('is turned off by an empty array, which is what makes it a default', async () => {
		// The escape hatch, and the reason this option exists on the front
		// door: a default a caller cannot disable is a change to their
		// program, not a default.
		const mock = provider()

		await runAgent({
			provider: mock,
			model: 'mock-model',
			prompt: 'find the rollback procedure',
			tools: hostRegistry(echoingTool('weather-co')),
			toolResultGuardrails: [],
		})

		expect(toolMessages(mock)).toContain(QUERY)
	})

	it('runs a screen the caller supplies in place of the default', async () => {
		const mock = provider()

		await runAgent({
			provider: mock,
			model: 'mock-model',
			prompt: 'find the rollback procedure',
			tools: hostRegistry(echoingTool('weather-co')),
			toolResultGuardrails: [
				{ name: 'host-rule', check: () => ({ action: 'refuse' as const, reason: 'not today' }) },
			],
		})

		expect(toolMessages(mock)).toContain('host-rule')
		expect(toolMessages(mock)).not.toContain('tool-result-correspondence')
	})
})
