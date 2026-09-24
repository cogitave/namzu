import {
	MockLLMProvider,
	type ToolDefinition,
	ToolManager,
	findPortableSchemaViolations,
	getBuiltinTools,
	toolset,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { buildSwitchModelTool } from '../../tui/model-switch-tool.js'
import {
	buildConversationReadTool,
	buildConversationSearchTool,
} from '../sessions/conversation-search.js'
import { subagentParentFixture } from '../subagents/__fixtures__/parent.js'
import { createSubagentRuntime } from '../subagents/runtime.js'
import { createWebSearchTool } from '../web/search.js'

/**
 * The CLI's own tools, held to the same bar as the kernel's.
 *
 * A request carries ONE tools block. The kernel's builtins and the tools this
 * application adds ride in it together, and a wire that validates tool
 * `parameters` — Zen's Console gateway validates against the JSON Schema
 * 2020-12 metaschema — rejects the whole request over one bad field. So a gate
 * that covered `@namzu/sdk` alone would leave the model's actual tool surface
 * half-checked: the owner's 400 named "Tool 4", and which tool sits at index 4
 * depends on the roster this package assembled.
 *
 * The profile is the SDK's own `findPortableSchemaViolations` — the
 * intersection of draft-07 and 2020-12 — imported rather than restated, so the
 * two packages cannot drift into disagreeing about what portable means.
 */

async function subagentTools(): Promise<ToolDefinition[]> {
	const parent = await subagentParentFixture(process.cwd())
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: process.cwd(),
		model: 'test-model',
		// Never asked anything: the tools are read off the runtime, not run.
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: () => [toolset('test', getBuiltinTools())],
	})
	try {
		return [
			runtime.agentTool,
			runtime.waitForTaskTool,
			runtime.agentTaskListTool,
			runtime.sendMessageTool,
			runtime.cancelAgentTool,
			runtime.narrationTool,
			...(runtime.modelCatalogueTool ? [runtime.modelCatalogueTool] : []),
		]
	} finally {
		await runtime.close()
	}
}

function refuse(): never {
	throw new Error('not used')
}

async function everyCliTool(): Promise<ToolDefinition[]> {
	return [
		...(await subagentTools()),
		createWebSearchTool(),
		buildSwitchModelTool(() => Promise.reject(new Error('not used'))),
		buildConversationSearchTool(refuse),
		buildConversationReadTool(refuse),
	]
}

describe('every tool the CLI adds to the request', () => {
	it('stays inside the draft-07 ∩ 2020-12 profile', async () => {
		const registry = new ToolManager({
			toolsets: [toolset('test', await everyCliTool())],
			messages: () => [],
		})

		const offenders = registry
			.toLLMTools()
			.map((tool) => ({
				name: tool.function.name,
				violations: findPortableSchemaViolations(tool.function.parameters),
			}))
			.filter((entry) => entry.violations.length > 0)

		expect(offenders).toEqual([])
	})

	it('covers the tools this application actually mounts', async () => {
		const names = (await everyCliTool()).map((tool) => tool.name)

		expect(names).toContain('Agent')
		expect(names).toContain('web_search')
		expect(names).toContain('search_conversation')
		expect(names.length).toBeGreaterThanOrEqual(9)
	})
})
