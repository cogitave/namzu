/**
 * The explore sub-agent cannot change anything, and a role cannot make it.
 *
 * The property is on the ROSTER the child is built with, not on the prompt:
 * a prompt that says "you are read-only" over a registry that holds `write`
 * is a request, and this file exists because the parent's working set was
 * what every child got. So these build the runtime with the real builtin
 * set, take the definition the `Agent` tool would spawn, and read the tools
 * its config actually carries.
 */

import {
	type AgentDefinition,
	AgentRegistry,
	MockLLMProvider,
	ToolRegistry,
	getBuiltinTools,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EXPLORE_SUBAGENT, GENERAL_PURPOSE_SUBAGENT, createSubagentRuntime } from '../runtime.js'

afterEach(() => {
	vi.restoreAllMocks()
})

function fullTools(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(getBuiltinTools())
	return tools
}

/**
 * The runtime keeps its registry private, so the definitions are captured
 * where they are registered — the same seam the session-level tests use.
 */
async function runtimeWithBuiltins() {
	const registered: AgentDefinition[] = []
	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation(function (
		this: AgentRegistry,
		def,
	) {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})
	const runtime = await createSubagentRuntime({
		cwd: process.cwd(),
		model: 'test-model',
		// The config builder constructs a provider alongside the roster; a mock
		// with no turns is one that is never asked anything.
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: fullTools,
	})
	return { runtime, registered }
}

async function toolsOf(registered: readonly AgentDefinition[], id: string) {
	const definition = registered.find((d) => d.info.id === id)
	if (!definition?.configBuilder) throw new Error(`no definition registered for ${id}`)
	const config = (await definition.configBuilder({})) as unknown as {
		tools: { listNames(): string[] }
		systemPrompt?: string
	}
	return { names: config.tools.listNames().sort(), prompt: config.systemPrompt ?? '' }
}

describe('the explore sub-agent', () => {
	it('is offered beside general-purpose', async () => {
		const { runtime } = await runtimeWithBuiltins()
		expect(runtime.allowedAgentIds).toEqual([GENERAL_PURPOSE_SUBAGENT, EXPLORE_SUBAGENT])
		// The schema the model is validated against accepts the new type and
		// still refuses one it does not know.
		const accepts = (subagent_type: string) =>
			runtime.agentTool.inputSchema.safeParse({ description: 'd', prompt: 'p', subagent_type })
				.success
		expect(accepts(EXPLORE_SUBAGENT)).toBe(true)
		expect(accepts('archivist')).toBe(false)
	})

	it('carries only tools that declare themselves read-only', async () => {
		const { registered } = await runtimeWithBuiltins()
		const { names, prompt } = await toolsOf(registered, EXPLORE_SUBAGENT)

		expect(names).toContain('read')
		expect(names).toContain('grep')
		expect(names).toContain('glob')
		for (const mutating of ['write', 'edit', 'bash']) {
			expect(names, `${mutating} must not reach a read-only child`).not.toContain(mutating)
		}
		expect(prompt).toContain('reading and searching tools only')
		expect(prompt, 'the shared working doctrine still applies').toContain('## How you work')
	})

	it('leaves the general-purpose roster whole', async () => {
		const { registered } = await runtimeWithBuiltins()
		const { names } = await toolsOf(registered, GENERAL_PURPOSE_SUBAGENT)
		for (const name of ['read', 'write', 'edit', 'bash']) expect(names).toContain(name)
	})
})
