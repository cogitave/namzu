import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveSupervisorOptions } from '../derive-supervisor.js'
import { loadProject } from '../load.js'

/**
 * `BaseAgentConfig` declares `tokenBudget` and `timeoutMs` as REQUIRED, and
 * `deriveSupervisorOptions` supplied them only when `agent.ts` happened to
 * name them — which is the uncommon case. An `as SupervisorAgentConfig` made
 * that compile, so the returned object was typed `tokenBudget: number` while
 * holding `undefined`.
 *
 * The consequence is not a type-level nicety. `buildLimitConfig` defaults only
 * `maxIterations`, so an undefined budget and timeout disable BOTH hard stops
 * — a project-derived supervisor ran with no token cap and no wall clock. And
 * the child-spawn guard computes a delegate's allocation from the parent
 * budget, so `undefined` became `NaN`, and `NaN <= 0` is false: the refusal
 * that exists to stop an unfunded child let it through.
 *
 * The cast is now `satisfies`, which is what keeps this from recurring — but
 * a type check is not a test, so the values are asserted here too.
 */

const provider = { id: 'mock', name: 'Mock' } as never
const agentManager = { sendMessage: async () => ({}) } as never

function tree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-budget-'))
	for (const [relative, body] of Object.entries(files)) {
		const full = join(root, relative)
		mkdirSync(join(full, '..'), { recursive: true })
		writeFileSync(full, body)
	}
	return root
}

const MINIMAL = {
	'agent.js': 'export default { model: "m" }',
	'agents/researcher/agent.js': 'export default { model: "m2" }',
	'agents/researcher/instructions.md': 'Research things.',
}

describe('a derived supervisor always has a budget and a clock', () => {
	it('defaults both when agent.ts names neither', async () => {
		const { manifest } = await loadProject(tree(MINIMAL))
		const { config } = deriveSupervisorOptions(manifest, { provider, agentManager })

		// The exact numbers matter less than that they are finite: a NaN or an
		// undefined here is what silently disabled the limits.
		expect(Number.isFinite(config.tokenBudget)).toBe(true)
		expect(Number.isFinite(config.timeoutMs)).toBe(true)
		expect(config.tokenBudget).toBeGreaterThan(0)
		expect(config.timeoutMs).toBeGreaterThan(0)
	})

	it('uses the same defaults the SDK front door uses', async () => {
		const { DEFAULT_TIMEOUT_MS, DEFAULT_TOKEN_BUDGET } = await import('@namzu/sdk')
		const { manifest } = await loadProject(tree(MINIMAL))
		const { config } = deriveSupervisorOptions(manifest, { provider, agentManager })

		// Two front doors that default differently is a difference nobody would
		// find until a run behaved unlike its sibling.
		expect(config.tokenBudget).toBe(DEFAULT_TOKEN_BUDGET)
		expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS)
	})

	it('still honours what agent.ts declares', async () => {
		const { manifest } = await loadProject(
			tree({
				...MINIMAL,
				'agent.js': 'export default { model: "m", tokenBudget: 1234, timeoutMs: 5678 }',
			}),
		)
		const { config } = deriveSupervisorOptions(manifest, { provider, agentManager })

		expect(config.tokenBudget).toBe(1234)
		expect(config.timeoutMs).toBe(5678)
	})

	it('lets an override win over both', async () => {
		const { manifest } = await loadProject(tree(MINIMAL))
		const { config } = deriveSupervisorOptions(manifest, {
			provider,
			agentManager,
			overrides: { tokenBudget: 42 },
		})

		expect(config.tokenBudget).toBe(42)
	})
})

describe('a derived supervisor carries the skills it loaded', () => {
	it('passes skills through instead of dropping them', async () => {
		const { manifest } = await loadProject(
			tree({
				...MINIMAL,
				'skills/plan-a-trip/SKILL.md':
					'---\nname: plan-a-trip\ndescription: Plan a trip\n---\n\nAsk for dates.',
			}),
		)
		expect(manifest.skills).toHaveLength(1)

		const { config } = deriveSupervisorOptions(manifest, { provider, agentManager })

		// Loaded from disk, put on the manifest, and then — before this — left
		// out of the config the supervisor actually runs with.
		expect(config.skills).toHaveLength(1)
		expect(config.skills?.[0]?.metadata.name).toBe('plan-a-trip')
	})
})
