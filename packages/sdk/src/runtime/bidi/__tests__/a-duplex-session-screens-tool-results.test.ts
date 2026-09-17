import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { frameServerResult } from '../../../connector/mcp/adapter.js'
import { ToolRegistry } from '../../../registry/index.js'
import { untrustedEnvelopeBody } from '../../../tools/untrusted-envelope.js'
import type { ToolDefinition, ToolRegistryConfig } from '../../../types/tool/index.js'
import { createMockBidiProvider } from '../mock.js'
import { startBidiRun } from '../session.js'

/**
 * A duplex session builds its OWN tool context — it has no executor, no
 * iteration and no `buildToolContext` — so the run-level default reaches it
 * only because it is installed here too. Without that, a session's tool
 * results would be the one path in the kernel that reaches a model unscreened,
 * and the gap would be invisible: both paths look like "a tool ran".
 */

const QUERY = 'the deployment rollback procedure for the payments service'

/**
 * A raw definition rather than `defineTool`: provenance is what a CONNECTOR
 * marks a tool with, and `defineTool` is the host-authored path, which has no
 * provenance to declare.
 *
 * A connected tool also frames its result, as the adapter does — the frame is
 * what the default scope reads, and a stand-in carrying only the provenance
 * would be a shape no connector produces.
 */
function echoingTool(provenance?: ToolDefinition['provenance']): ToolDefinition {
	return {
		name: 'lookup',
		description: 'lookup',
		inputSchema: z.object({ query: z.string() }),
		...(provenance ? { provenance } : {}),
		async execute(input) {
			const result = {
				success: true,
				output: (input as { query: string }).query,
			}
			return provenance === undefined
				? result
				: frameServerResult(result, provenance.server, 'lookup')
		},
	}
}

const CONNECTED = { server: 'weather-co', readOnlyHintTrusted: false } as const

/** Drive one tool call through a real duplex run and report what the model was handed. */
async function delivered(
	tool: ToolDefinition,
	options: {
		readonly config?: ToolRegistryConfig
		readonly screens?: readonly never[]
	} = {},
): Promise<{ output: string; isError: boolean }> {
	const registry = new ToolRegistry(options.config)
	registry.register(tool)

	const provider = createMockBidiProvider({
		auto: true,
		events: [
			{
				type: 'tool_call',
				id: 'call-1',
				name: 'lookup',
				arguments: JSON.stringify({ query: QUERY }),
			},
		],
	})
	const run = await startBidiRun({
		provider,
		tools: registry,
		connect: { model: 'mock' },
		workingDirectory: process.cwd(),
		...(options.screens === undefined ? {} : { toolResultGuardrails: options.screens }),
	})
	const session = provider.session()
	if (!session) throw new Error('mock session missing')

	await vi.waitFor(() => {
		expect(session.sent.some((entry) => 'toolResult' in entry)).toBe(true)
	})
	await run.close()

	const sent = session.sent.find(
		(entry): entry is { toolResult: string; output: string; isError: boolean } =>
			'toolResult' in entry,
	)
	if (!sent) throw new Error('no tool result was delivered')
	return sent
}

describe('a duplex session screens a connected result', () => {
	it('refuses one that restates the request', async () => {
		const result = await delivered(echoingTool(CONNECTED))

		expect(result.isError).toBe(true)
		expect(result.output).toContain('tool-result-correspondence')
	})

	it('leaves an unframed host tool alone, as the default scope says', async () => {
		const result = await delivered(echoingTool())

		expect(result.isError).toBe(false)
		expect(result.output).toBe(QUERY)
	})

	it('is turned off by an empty array', async () => {
		const result = await delivered(echoingTool(CONNECTED), { screens: [] })

		expect(result.isError).toBe(false)
		// Unrefused, so what is delivered is the server's framed answer —
		// the same shape a connector's working result has.
		expect(untrustedEnvelopeBody(result.output)).toBe(QUERY)
	})

	it('lets a registry built with its own screens win, as it does on the query path', async () => {
		const result = await delivered(echoingTool(CONNECTED), {
			config: { resultGuardrails: [] },
		})

		expect(result.isError).toBe(false)
		expect(untrustedEnvelopeBody(result.output)).toBe(QUERY)
	})
})
