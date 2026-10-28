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
	type Toolset,
	getBuiltinTools,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { subagentParentFixture } from '../__fixtures__/parent.js'
import { FORK_SUBAGENT } from '../fork.js'
import {
	EXPLORE_SUBAGENT,
	GENERAL_PURPOSE_SUBAGENT,
	PLAN_SUBAGENT,
	createSubagentRuntime,
} from '../runtime.js'

afterEach(() => {
	vi.restoreAllMocks()
})

function fullTools(): readonly Toolset[] {
	return [toolset('test', getBuiltinTools())]
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
	const parent = await subagentParentFixture(process.cwd())
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
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
		toolsets: readonly Toolset[]
		systemPrompt?: string
	}
	return {
		names: config.toolsets
			.flatMap((ts) => ts.tools())
			.map((tool) => tool.name)
			.sort(),
		prompt: config.systemPrompt ?? '',
	}
}

describe('the explore sub-agent', () => {
	it('is offered beside general-purpose', async () => {
		const { runtime } = await runtimeWithBuiltins()
		expect(runtime.allowedAgentIds).toEqual([
			GENERAL_PURPOSE_SUBAGENT,
			EXPLORE_SUBAGENT,
			PLAN_SUBAGENT,
			FORK_SUBAGENT,
		])
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

describe('the plan sub-agent', () => {
	it('is offered, and the schema accepts it', async () => {
		const { runtime } = await runtimeWithBuiltins()
		expect(runtime.allowedAgentIds).toContain(PLAN_SUBAGENT)
		expect(
			runtime.agentTool.inputSchema.safeParse({
				description: 'd',
				prompt: 'p',
				subagent_type: PLAN_SUBAGENT,
			}).success,
		).toBe(true)
		expect(runtime.agentTool.description).toContain('"plan"')
	})

	it('carries the explore roster and no tool that changes anything', async () => {
		const { registered } = await runtimeWithBuiltins()
		const plan = await toolsOf(registered, PLAN_SUBAGENT)
		const explore = await toolsOf(registered, EXPLORE_SUBAGENT)

		expect(plan.names).toEqual(explore.names)
		for (const mutating of ['write', 'edit', 'bash']) {
			expect(plan.names, `${mutating} must not reach a planner`).not.toContain(mutating)
		}
	})

	it('asks for a step plan with files and risks, under the shared working rules', async () => {
		const { registered } = await runtimeWithBuiltins()
		const { prompt } = await toolsOf(registered, PLAN_SUBAGENT)

		expect(prompt).toContain('reading and searching tools only')
		expect(prompt).toContain('numbered steps')
		expect(prompt).toContain('risks')
		expect(prompt).toContain('## How you work')
		expect(prompt).not.toBe((await toolsOf(registered, EXPLORE_SUBAGENT)).prompt)
	})

	it('is a read-only launch, so starting one needs no question', async () => {
		const { runtime } = await runtimeWithBuiltins()
		expect(runtime.launchesReadOnlyAgent({ subagent_type: PLAN_SUBAGENT })).toBe(true)
		expect(runtime.launchesReadOnlyAgent({ subagent_type: GENERAL_PURPOSE_SUBAGENT })).toBe(false)
	})
})

describe('a project file named plan', () => {
	it('is the planner that starts, with the tools its file allows rather than the read-only roster', async () => {
		const replaced: AgentDefinition[] = []
		vi.spyOn(AgentRegistry.prototype, 'replace').mockImplementation(function (
			this: AgentRegistry,
			_id,
			def,
		) {
			replaced.push(def as AgentDefinition)
		})
		const parent = await subagentParentFixture(process.cwd())
		const runtime = await createSubagentRuntime({
			resolveParent: parent.resolveParent,
			cwd: process.cwd(),
			model: 'test-model',
			buildProvider: () => new MockLLMProvider({ turns: [] }),
			buildTools: fullTools,
			definitions: [
				{
					name: PLAN_SUBAGENT,
					description: 'Plans, and may edit the plan file.',
					prompt: 'PROJECT PLANNER',
					readOnly: false,
					path: '/p/.namzu/agents/plan.md',
					source: 'project',
				},
			],
		})
		try {
			expect(runtime.allowedAgentIds.filter((id) => id === PLAN_SUBAGENT)).toHaveLength(1)
			const file = replaced.find((d) => d.info.id === PLAN_SUBAGENT)
			if (!file?.configBuilder) throw new Error('the project file did not replace the planner')
			const config = (await file.configBuilder({})) as unknown as {
				toolsets: readonly Toolset[]
				systemPrompt?: string
			}
			const names = config.toolsets.flatMap((ts) => ts.tools()).map((tool) => tool.name)
			expect(config.systemPrompt).toContain('PROJECT PLANNER')
			expect(config.systemPrompt).not.toContain('numbered steps')
			for (const mutating of ['write', 'edit', 'bash']) expect(names).toContain(mutating)
		} finally {
			await runtime.close()
		}
	})
})
