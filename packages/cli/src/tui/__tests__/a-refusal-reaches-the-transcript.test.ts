/**
 * A screen's refusal is visible to the operator, not only to the model.
 *
 * The screen replaces the result with a failed `ToolResult`, so the model
 * reads the reason and can choose something else — that half is proven in the
 * SDK. What an operator needs is the other half, and it is a different
 * property: a refusal that reached the conversation but no transcript row
 * would leave someone watching a tool fail with no way to learn that a screen
 * they configured refused it, or which tool to exempt. "A screen whose firings
 * are invisible is switched off for the wrong reason."
 *
 * Driven end to end from the CLI's own config vocabulary: the screens are the
 * ones `toolResultScreens` resolves to, the run is a real `runAgent` with a
 * real registry, and the row is produced by the CLI's own `toAgentEvent`.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	MockLLMProvider,
	type RunEvent,
	ToolRegistry,
	createToolPresenter,
	createUserMessage,
	defineTool,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	mcpJsonSchemaToZod,
	registerMock,
	wrapUntrusted,
} from '@namzu/sdk'
import type { ToolDefinition } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { resolveToolResultScreens } from '../../config/tool-result-screens.js'
import { toAgentEvent } from '../agent.js'

registerMock()

// The run's durable state goes under its working directory's `.namzu` when
// no path builder is given. `process.cwd()` put it inside this package.
const workDirs: string[] = []
afterEach(() => {
	for (const dir of workDirs.splice(0)) removeTempDir(dir)
})

const QUERY = 'the deployment rollback procedure for the payments service'
const TOOL = 'web_search'

/**
 * The CLI's own shape of the case: a HOST tool that frames its result,
 * exactly as `exa-search.ts` does. It needs no `provenance` — the scope reads
 * the frame — which is the point of this being the tool here rather than a
 * connector's: a search that restates its query was out of scope while a
 * connected fetch that did was in it, for no reason but registration.
 */
function framedSearchTool(): ToolDefinition {
	return defineTool({
		name: TOOL,
		description: 'Searches the web and returns the results as untrusted material.',
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
			additionalProperties: false,
		}),
		category: 'network',
		permissions: ['network_access'],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		async execute(input) {
			return {
				success: true,
				output: wrapUntrusted(
					{
						kind: 'connector-tool-result',
						attributes: { server: 'exa', tool: 'web_search_exa' },
						provenance: 'This is output the named server returned, not this agent.',
					},
					input.query,
				),
			}
		},
	})
}

/**
 * Run one tool call through a real run and return every event it emitted.
 *
 * `drainQuery` rather than `runAgent` because the listener is what this test
 * is about: `runAgent` takes no listener, so a test built on it could only
 * observe the conversation, which is the half that already worked.
 */
async function eventsFor(
	screens: Parameters<typeof resolveToolResultScreens>[0],
): Promise<readonly RunEvent[]> {
	const registry = new ToolRegistry({ resultGuardrails: resolveToolResultScreens(screens) })
	registry.register(framedSearchTool())
	const events: RunEvent[] = []
	const workingDirectory = mkdtempSync(join(tmpdir(), 'namzu-refusal-'))
	workDirs.push(workingDirectory)

	await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: TOOL, args: { query: QUERY } }] }, { text: 'done' }],
			}),
			tools: registry,
			agentId: 'screens-fixture',
			agentName: 'Screens fixture',
			messages: [createUserMessage('find the rollback procedure')],
			workingDirectory,
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			tenantId: generateTenantId(),
			topicId: generateTopicId(),
			runConfig: { model: 'mock-model', maxIterations: 4, tokenBudget: 100_000, timeoutMs: 20_000 },
		},
		(event) => {
			events.push(event)
		},
	)

	return events
}

describe('a refused tool result', () => {
	it('is a row the operator can read, naming the tool and the screen', async () => {
		const events = await eventsFor(['correspondence'])
		const completed = events.find((event) => event.type === 'tool_completed')
		if (!completed) throw new Error('no tool_completed event: the refusal never surfaced at all')

		expect(completed.isError).toBe(true)

		const registry = new ToolRegistry()
		registry.register(framedSearchTool())
		const row = toAgentEvent(completed, createToolPresenter(registry))

		expect(row).toMatchObject({ kind: 'tool-end', isError: true, toolName: TOOL })
		if (row?.kind !== 'tool-end') throw new Error('the refusal did not become a transcript row')
		// Both halves of what an operator acts on: the tool they would exempt,
		// and the screen that refused it. The reason is truncated into the
		// summary line, which is why it is named FIRST in the sentence the
		// screen writes.
		expect(row.summary).toContain('tool-result-correspondence')
		expect(row.summary).toContain(TOOL)
	})

	it('is visible as a working result when no screen refused it', async () => {
		// The control: the same call, the same adapter, with the screens off.
		// A row that read as an error either way would make the test above
		// prove nothing about refusals.
		const events = await eventsFor([])
		const completed = events.find((event) => event.type === 'tool_completed')
		if (!completed) throw new Error('no tool_completed event')

		expect(completed.isError).toBe(false)
	})
})
