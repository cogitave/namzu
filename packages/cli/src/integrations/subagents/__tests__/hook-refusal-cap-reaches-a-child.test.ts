import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, SessionPaths } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import type { TurnLimitsConfig } from '../../../config/schema.js'
import { DEFAULT_MAX_HOOK_REFUSALS } from '../../../config/turn-guards.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * A delegated child ends after the CLI's default number of end-of-turn hook
 * refusals, and `limits.maxHookRefusals: 0` lifts it. The child's turn config is
 * built apart from the parent's, so the default has to reach it on its own.
 */

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

/** A hook manager whose `subagent_stop` always refuses. */
const refusingManager = {
	executeHooks: async (
		event: string,
		ctx: { sessionId: string; turnId?: string },
		emit?: (e: unknown) => Promise<void>,
	) => {
		if (event !== 'subagent_stop') return []
		const result = { action: 'skip', reason: 'not yet' }
		await emit?.({
			type: 'plugin_hook_completed',
			sessionId: ctx.sessionId,
			pluginId: 'closing-gate',
			hookEvent: event,
			result,
		})
		return [result]
	},
} as never

async function childRequests(limits: TurnLimitsConfig | undefined): Promise<number> {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-hook-cap-'))
	dirs.push(cwd)
	const parent = await subagentParentFixture(cwd)
	const child = new MockLLMProvider({
		turns: Array.from({ length: 60 }, (_, i) => ({ text: `say ${i}` })),
	})
	const runtime = await createSubagentRuntime({
		cwd,
		model: 'parent-model',
		resolveParent: parent.resolveParent,
		buildTools: () => [],
		buildProvider: () => child,
		resolvePluginManager: () => refusingManager,
		resolveLimits: () => limits,
		resolveResumeHandler: () => async () => ({ action: 'continue' }),
		paths: new SessionPaths({ home: join(cwd, 'state'), slug: '-work-child-hook-cap' }),
		maxIterations: 20,
	})
	try {
		// Without a cap the child runs out of iterations, which reports as incomplete;
		// the number of model calls is what this measures.
		await runtime.agentTool.execute(
			{ description: 'probe', prompt: 'say something' },
			{
				sessionId: parent.scope.sessionId,
				turnId: parent.scope.turnId,
				workingDirectory: cwd,
				abortSignal: new AbortController().signal,
				env: {},
				log() {},
			},
		)
	} finally {
		await runtime.close()
	}
	return child.requests.length
}

it('ends a child after the default number of refusals when the config says nothing', async () => {
	expect(await childRequests(undefined)).toBe(DEFAULT_MAX_HOOK_REFUSALS + 1)
})

it('ends a child after the configured number of refusals', async () => {
	expect(await childRequests({ maxHookRefusals: 3 })).toBe(4)
})

it('puts no cap on a child when the limit is 0', async () => {
	expect(await childRequests({ maxHookRefusals: 0 })).toBe(20)
})
