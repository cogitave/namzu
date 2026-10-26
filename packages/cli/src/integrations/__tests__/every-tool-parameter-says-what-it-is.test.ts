import {
	type BrowserHost,
	MockLLMProvider,
	type ToolDefinition,
	ToolManager,
	buildSessionLoopTools,
	createBrowserTools,
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
 * A parameter the model has to guess at is a parameter it fills in wrong. Every
 * property the request's tool schemas declare says what it is, in a clause, so
 * a name like `op`, `seq` or `values` never rides alone.
 */

function refuse(): never {
	throw new Error('not used')
}

const browserHost = {
	capabilities: { screenshot: true, upload: true },
} as unknown as BrowserHost

async function roster(): Promise<ToolDefinition[]> {
	const parent = await subagentParentFixture(process.cwd())
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd: process.cwd(),
		model: 'test-model',
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: () => [toolset('test', getBuiltinTools())],
	})
	try {
		return [
			...getBuiltinTools(),
			...createBrowserTools(browserHost),
			...buildSessionLoopTools({
				list: () => [],
				delete: async () => 0,
				create: refuse,
			} as never),
			runtime.agentTool,
			runtime.waitForTaskTool,
			runtime.agentTaskListTool,
			runtime.sendMessageTool,
			runtime.cancelAgentTool,
			runtime.narrationTool,
			createWebSearchTool(),
			buildSwitchModelTool(() => Promise.reject(new Error('not used'))),
			buildConversationSearchTool(refuse),
			buildConversationReadTool(refuse),
		]
	} finally {
		await runtime.close()
	}
}

type Schema = {
	properties?: Record<string, Schema & { description?: string }>
	items?: Schema
	description?: string
}

function undescribed(name: string, schema: Schema | undefined, path = ''): string[] {
	if (!schema) return []
	const out: string[] = []
	for (const [key, value] of Object.entries(schema.properties ?? {})) {
		if (!value.description?.trim()) out.push(`${name}.${path}${key}`)
		out.push(...undescribed(name, value, `${path}${key}.`))
	}
	if (schema.items) out.push(...undescribed(name, schema.items, `${path}[].`))
	return out
}

describe('the tools in a request', () => {
	it('describe every parameter they declare', async () => {
		const registry = new ToolManager({
			toolsets: [toolset('test', await roster())],
			messages: () => [],
		})
		const bare = registry
			.toLLMTools()
			.flatMap((tool) => undescribed(tool.function.name, tool.function.parameters as Schema))
		expect(bare).toEqual([])
	})

	it('use ordinary emphasis in their descriptions, with no capitals stacks', async () => {
		const registry = new ToolManager({
			toolsets: [toolset('test', await roster())],
			messages: () => [],
		})
		const shouting =
			/\b(MUST|NOT|ONLY|NEVER|ALWAYS|DO NOT|REQUIRED|CRITICAL|IMPORTANT|THIS|PREFERRED|FIRST|ALL|ONE|ANOTHER|CLAIM|BEFORE)\b/
		const offenders: string[] = []
		for (const tool of registry.toLLMTools()) {
			const texts: [string, string][] = [[tool.function.name, tool.function.description ?? '']]
			const walk = (path: string, schema: Schema | undefined) => {
				for (const [key, value] of Object.entries(schema?.properties ?? {})) {
					texts.push([`${tool.function.name}.${path}${key}`, value.description ?? ''])
					walk(`${path}${key}.`, value)
				}
				if (schema?.items) walk(`${path}[].`, schema.items)
			}
			walk('', tool.function.parameters as Schema)
			for (const [where, text] of texts) if (shouting.test(text)) offenders.push(where)
		}
		expect(offenders).toEqual([])
	})

	it('cover the tools this application mounts', async () => {
		const names = (await roster()).map((tool) => tool.name)
		for (const name of ['browser', 'browser_act', 'session_loop', 'search_conversation'])
			expect(names).toContain(name)
	})
})
