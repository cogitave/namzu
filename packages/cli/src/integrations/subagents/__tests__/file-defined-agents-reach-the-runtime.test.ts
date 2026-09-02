/**
 * An agent defined in a file becomes a type the `Agent` tool offers, with
 * the roster, model and prompt the file asked for — and no more roster than
 * the parent has.
 *
 * Same seam as the explore test: the definitions are captured where they
 * are registered, and the config each one builds is read directly.
 */

import {
	type AgentDefinition,
	AgentRegistry,
	MockLLMProvider,
	ToolRegistry,
	getBuiltinTools,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentFileDefinition } from '../definitions.js'
import { EXPLORE_SUBAGENT, GENERAL_PURPOSE_SUBAGENT, createSubagentRuntime } from '../runtime.js'

afterEach(() => {
	vi.restoreAllMocks()
})

const reviewer: AgentFileDefinition = {
	name: 'reviewer',
	description: 'Reviews a diff for correctness.',
	prompt: 'REVIEWER-PROMPT: cite file:line for every finding.',
	tools: ['read', 'grep', 'bash', 'not-a-real-tool'],
	model: 'reviewer-model',
	readOnly: false,
	path: '/p/.namzu/agents/reviewer.md',
	source: 'project',
}

const auditor: AgentFileDefinition = {
	name: 'auditor',
	description: 'Reads and reports; changes nothing.',
	prompt: 'AUDITOR-PROMPT',
	tools: ['read', 'write', 'bash'],
	readOnly: true,
	path: '/p/.namzu/agents/auditor.md',
	source: 'project',
}

async function runtimeWith(definitions: readonly AgentFileDefinition[]) {
	const registered: AgentDefinition[] = []
	vi.spyOn(AgentRegistry.prototype, 'register').mockImplementation(function (
		this: AgentRegistry,
		def,
	) {
		for (const d of Array.isArray(def) ? def : [def]) registered.push(d)
	})
	const runtime = await createSubagentRuntime({
		cwd: process.cwd(),
		model: 'session-model',
		buildProvider: () => new MockLLMProvider({ turns: [] }),
		buildTools: () => {
			const tools = new ToolRegistry()
			tools.register(getBuiltinTools())
			return tools
		},
		definitions,
	})
	return { runtime, registered }
}

async function configOf(registered: readonly AgentDefinition[], id: string) {
	const definition = registered.find((d) => d.info.id === id)
	if (!definition?.configBuilder) throw new Error(`no definition registered for ${id}`)
	const config = (await definition.configBuilder({})) as unknown as {
		model: string
		tools: { listNames(): string[] }
		systemPrompt?: string
	}
	return {
		model: config.model,
		names: config.tools.listNames().sort(),
		prompt: config.systemPrompt ?? '',
		description: definition.info.description,
	}
}

describe('a file-defined agent', () => {
	it('is offered beside the built-in types, described for the model', async () => {
		const { runtime } = await runtimeWith([reviewer, auditor])
		expect(runtime.allowedAgentIds).toEqual([
			GENERAL_PURPOSE_SUBAGENT,
			EXPLORE_SUBAGENT,
			'reviewer',
			'auditor',
		])
		const accepts = (subagent_type: string) =>
			runtime.agentTool.inputSchema.safeParse({ description: 'd', prompt: 'p', subagent_type })
				.success
		expect(accepts('reviewer')).toBe(true)
		expect(accepts('archivist')).toBe(false)
		expect(runtime.agentTool.description).toContain('"reviewer" — Reviews a diff for correctness.')
	})

	it("carries the file's prompt, model and allowlisted tools — intersected with the parent's set", async () => {
		const { registered } = await runtimeWith([reviewer])
		const config = await configOf(registered, 'reviewer')

		expect(config.model).toBe('reviewer-model')
		expect(config.names).toEqual(['bash', 'grep', 'read'])
		expect(config.prompt).toContain('REVIEWER-PROMPT')
		expect(config.prompt, 'the shared sub-agent base still applies').toContain('## How you work')
		expect(config.description).toBe('Reviews a diff for correctness.')
	})

	it('cannot be handed a mutating tool through its allowlist when it is read-only', async () => {
		const { registered } = await runtimeWith([auditor])
		const config = await configOf(registered, 'auditor')

		expect(config.names).toEqual(['read'])
		expect(config.model, 'no model in the file means the session model').toBe('session-model')
	})

	it('leaves the built-in types as they were', async () => {
		const { registered } = await runtimeWith([reviewer])
		const general = await configOf(registered, GENERAL_PURPOSE_SUBAGENT)
		expect(general.model).toBe('session-model')
		for (const name of ['read', 'write', 'edit', 'bash']) expect(general.names).toContain(name)
	})
})
