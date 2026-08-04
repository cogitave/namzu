import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveSupervisorOptions } from '../derive-supervisor.js'
import { loadProject } from '../load.js'

/**
 * `SupervisorAgent` needs an `agentIds` roster and a manager that can spawn
 * them. Nothing led from a directory to either, so a multi-agent system could
 * be described on disk and not run.
 *
 * Delegates are loaded by recursion — a delegate directory has the same shape
 * as its parent — capped at one level, because how deep a system may fan out
 * is a topology decision and a directory layout should not make it by default.
 */

const provider = { id: 'mock', name: 'Mock' } as never
const agentManager = { sendMessage: async () => ({}) } as never

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-sub-'))
	for (const [relative, body] of Object.entries(files)) {
		const full = join(root, relative)
		mkdirSync(join(full, '..'), { recursive: true })
		writeFileSync(full, body)
	}
	return root
}

const TOOL = (name: string) => `
export default {
  name: ${JSON.stringify(name)},
  description: 'a tool',
  inputSchema: { parse: (v) => v, safeParse: (v) => ({ success: true, data: v }) },
  execute: async () => ({ success: true, output: 'ok' }),
}
`

const SYSTEM = {
	'instructions.md': 'You coordinate.',
	'agent.js': 'export default { model: "coordinator-model" }',
	'agents/researcher/instructions.md': 'You research.',
	'agents/researcher/agent.js': 'export default { model: "cheap-model" }',
	'agents/researcher/tools/search.js': TOOL('search'),
	'agents/writer/instructions.md': 'You write.',
}

describe('a project that declares delegates', () => {
	it('loads each one as a project in its own right', async () => {
		const { manifest, ok, diagnostics } = await loadProject(tree(SYSTEM))

		expect(ok, JSON.stringify(diagnostics)).toBe(true)
		expect(manifest.agents.map((a) => a.id).sort()).toEqual(['researcher', 'writer'])

		const researcher = manifest.agents.find((a) => a.id === 'researcher')
		expect(researcher?.manifest.instructions).toBe('You research.')
		expect(researcher?.manifest.tools.map((t) => t.definition.name)).toEqual(['search'])
		expect(researcher?.manifest.config.model).toBe('cheap-model')
	})

	it('surfaces a delegate failure in the parent list', async () => {
		// A delegate that could not load is a fact about THIS project. A caller
		// reading one list should not have to walk the tree to discover the run
		// will be short a specialist.
		const { manifest, ok, diagnostics } = await loadProject(
			tree({ ...SYSTEM, 'agents/writer/tools/bad.js': 'this is not valid !!!' }),
		)

		expect(ok).toBe(false)
		expect(diagnostics.some((d) => d.message.startsWith('agents/writer:'))).toBe(true)
		// The broken one is not offered as a delegate.
		expect(manifest.agents.map((a) => a.id)).toEqual(['researcher'])
	})

	it('refuses to read a second level of delegates', async () => {
		const { manifest, diagnostics } = await loadProject(
			tree({
				...SYSTEM,
				'agents/researcher/agents/deeper/instructions.md': 'You are too deep.',
			}),
		)

		const researcher = manifest.agents.find((a) => a.id === 'researcher')
		expect(researcher?.manifest.agents).toHaveLength(0)
		expect(diagnostics.some((d) => d.code === 'subagent_too_deep')).toBe(true)
	})

	it('imports nothing under modules: skip, delegates included', async () => {
		const { manifest, ok } = await loadProject(
			tree({
				'instructions.md': 'hi',
				'agents/x/instructions.md': 'hi',
				'agents/x/tools/boom.js': 'throw new Error("executed")',
			}),
			{ modules: 'skip' },
		)

		expect(ok).toBe(true)
		expect(manifest.sources.some((s) => s.slot === 'agents')).toBe(true)
	})
})

describe('deriving supervisor options', () => {
	it('builds the roster from the directory', async () => {
		const { manifest } = await loadProject(tree(SYSTEM))

		const { config, delegates } = deriveSupervisorOptions(manifest, { provider, agentManager })

		expect(config.agentIds.sort()).toEqual(['researcher', 'writer'])
		expect(config.systemPrompt).toBe('You coordinate.')
		expect(config.model).toBe('coordinator-model')
		expect(delegates).toHaveLength(2)
	})

	it('lets a delegate keep its own model and inherit when it has none', async () => {
		// A cheap model for a narrow job is the common case; inheriting
		// unconditionally would bill every specialist at the coordinator rate.
		const { manifest } = await loadProject(tree(SYSTEM))
		const { delegates } = deriveSupervisorOptions(manifest, { provider, agentManager })

		expect(delegates.find((d) => d.id === 'researcher')?.model).toBe('cheap-model')
		expect(delegates.find((d) => d.id === 'writer')?.model).toBe('coordinator-model')
	})

	it('carries each delegate its own instructions and tools', async () => {
		const { manifest } = await loadProject(tree(SYSTEM))
		const { delegates } = deriveSupervisorOptions(manifest, { provider, agentManager })

		const researcher = delegates.find((d) => d.id === 'researcher')
		expect(researcher?.systemPrompt).toBe('You research.')
		expect(researcher?.tools.has('search')).toBe(true)
	})

	it('refuses a project with no delegates', async () => {
		// An empty roster makes create_task unmountable, so the result would be
		// a coordinator that cannot coordinate — and the caller asked for one.
		const { manifest } = await loadProject(
			tree({ 'instructions.md': 'hi', 'agent.js': 'export default { model: "m" }' }),
		)

		expect(() => deriveSupervisorOptions(manifest, { provider, agentManager })).toThrow(
			/declares no delegates/,
		)
	})

	it('refuses a manifest whose modules were never loaded', async () => {
		const { manifest } = await loadProject(tree(SYSTEM), { modules: 'skip' })

		expect(() => deriveSupervisorOptions(manifest, { provider, agentManager })).toThrow(
			/modules: "skip"/,
		)
	})
})
