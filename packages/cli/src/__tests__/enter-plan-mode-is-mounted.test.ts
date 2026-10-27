/**
 * `enter_plan_mode` reaches the model the way a deferred tool does: named in
 * the deferred list with a one-line hint, and loadable on demand, in a session
 * where somebody can approve a plan. A sub-agent's roster is built separately
 * and does not carry it.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Toolset } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'

import type { DetectedProvider, Preferences } from '../integrations/providers/index.js'

const queryCalls: Record<string, unknown>[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			return (async function* () {})()
		},
	}
})

let root: string
beforeEach(() => {
	queryCalls.length = 0
	root = mkdtempSync(join(tmpdir(), 'namzu-enter-plan-'))
	mkdirSync(join(root, 'repo'), { recursive: true })
})
afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(root)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'sk-ant-not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

async function promptOf(planApproval: boolean): Promise<string> {
	const { createAgentSession } = await import('../tui/agent.js')
	const session = await createAgentSession(prefs, detected, {
		cwd: join(root, 'repo'),
		...(planApproval ? { planApproval: true } : {}),
	})
	for await (const _ of session.send([{ role: 'user', content: 'hi', timestamp: 0 }])) {
		// drain
	}
	expect(queryCalls).toHaveLength(1)
	const toolsets = (queryCalls[0]?.toolsets ?? []) as readonly Toolset[]
	const owner = toolsets.find((set) => set.tools().some((tool) => tool.name === 'enter_plan_mode'))
	return owner ? `has:${owner.availability ?? 'active'}` : 'absent'
}

describe('enter_plan_mode in a session', () => {
	it('is offered, deferred, where a plan can be approved, and only there', async () => {
		expect(await promptOf(true)).toBe('has:deferred')
		queryCalls.length = 0
		expect(await promptOf(false)).toBe('absent')
	})
})
