/**
 * Three saved settings reach the session: `workflow.enabled` (the workflow tool is offered or
 * not), `closingSummary` (the working rules end with the closing rule or without it) and the saved
 * default `effort` (used only where nothing else chose one). Driven through the real
 * AgentSession, with the kernel's `query` recorded.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ReminderSource,
	type ToolDefinition,
	type Toolset,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { NAMZU_WORKING_DOCTRINE } from '../../context/doctrine.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import type { AgentSessionOptions, SendOptions } from '../agent.js'

const queryCalls: Record<string, unknown>[] = []
/** Runs inside the turn, while the session still holds the authority the turn claimed. */
const duringTurn: { current?: (params: Record<string, unknown>) => Promise<void> } = vi.hoisted(
	() => ({}),
)
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: Record<string, unknown>) => {
			queryCalls.push(params)
			// The kernel claims the turn it was handed before any tool runs.
			;(params.claimTurn as ((id: unknown) => void) | undefined)?.(params.turnId)
			return (async function* () {
				await duringTurn.current?.(params)
				yield* []
			})()
		},
	}
})

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

function detectedAnthropic(): DetectedProvider[] {
	return [
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
}

let cwd: string
beforeEach(() => {
	queryCalls.length = 0
	duringTurn.current = undefined
	cwd = mkdtempSync(join(tmpdir(), 'namzu-workflow-offer-'))
})
afterEach(() => {
	removeTempDir(cwd)
})

/** A host that runs workflows says so, and says who answers for them. */
const REVIEWER: NonNullable<SendOptions['workflowReview']> = {
	onPermission: async () => ({ kind: 'approve' }),
	currentPermissionMode: () => 'prompt',
}

async function sendWith(
	text: string,
	options: SendOptions = {},
	sessionOptions: AgentSessionOptions = {},
) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detectedAnthropic(), {
		cwd,
		...sessionOptions,
	})
	try {
		for await (const _event of session.send([{ role: 'user', content: text, timestamp: 0 }], {
			workflowReview: REVIEWER,
			...options,
		})) {
			// drain the real AgentSession boundary
		}
	} finally {
		await session.close()
	}
	return queryCalls[0] as {
		toolsets: readonly Toolset[]
		systemPrompt?: string
		reminders?: ReminderSource
		turnConfig?: { effort?: string }
	}
}

function offered(call: { toolsets: readonly Toolset[] }): ToolDefinition | undefined {
	for (const toolset of call.toolsets) {
		const found = toolset.tools().find((tool) => tool.name === 'workflow')
		if (found) return found
	}
	return undefined
}

describe('workflow.enabled', () => {
	it('offers the tool when absent and when true', async () => {
		expect(offered(await sendWith('go'))).toBeDefined()
		queryCalls.length = 0
		expect(offered(await sendWith('go', {}, { workflow: { enabled: true } }))).toBeDefined()
	})

	it('leaves the tool out when false, whoever asks for it', async () => {
		const call = await sendWith(
			'use a workflow for this',
			{ workflow: true, hypermode: true },
			{ workflow: { enabled: false } },
		)
		expect(offered(call)).toBeUndefined()
		// Hypermode reads the text for a run without the tool, so no instruction names it.
		const said = (await call.reminders?.({ messages: [createUserMessage('go')] } as never)) ?? []
		const text = said.find((entry) => entry.includes('Hypermode'))
		expect(text).toContain('not available in this run')
		expect(text).toContain('`Agent`')
	})

	it('keeps the caps of the other workflow keys working', async () => {
		const call = await sendWith('go', {}, { workflow: { enabled: true, maxAgents: 7 } })
		expect(offered(call)).toBeDefined()
	})
})

describe('closingSummary', () => {
	const RULE =
		'- When you changed something, close with what changed, what was verified and what is left. For a question the reply is the answer.'

	it("keeps today's prompt whole when absent and when true", async () => {
		const absent = await sendWith('go')
		expect(absent.systemPrompt).toContain(NAMZU_WORKING_DOCTRINE)
		expect(absent.systemPrompt).toContain(RULE)
		queryCalls.length = 0
		const on = await sendWith('go', {}, { closingSummary: true })
		expect(on.systemPrompt).toBe(absent.systemPrompt)
	})

	it('drops only the closing rule when false', async () => {
		const on = await sendWith('go')
		queryCalls.length = 0
		const off = await sendWith('go', {}, { closingSummary: false })
		expect(off.systemPrompt).not.toContain('close with what changed')
		expect(off.systemPrompt).toBe((on.systemPrompt as string).replace(`\n${RULE}`, ''))
	})
})

describe('the saved default effort', () => {
	async function levelsOfTheModel(): Promise<readonly string[]> {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		try {
			return session.reasoningEffortLevels ?? []
		} finally {
			await session.close()
		}
	}

	it('is used when nothing chose a level and the model offers it', async () => {
		const [level] = await levelsOfTheModel()
		expect(level).toBeDefined()
		const call = await sendWith('go', {}, { savedEffort: level as never })
		expect(call.turnConfig?.effort).toBe(level)
	})

	it('yields to a level the caller chose', async () => {
		const levels = await levelsOfTheModel()
		expect(levels.length).toBeGreaterThan(1)
		const call = await sendWith(
			'go',
			{ effort: levels[1] as never },
			{ savedEffort: levels[0] as never },
		)
		expect(call.turnConfig?.effort).toBe(levels[1])
	})

	it('yields to NAMZU_EFFORT_LEVEL', async () => {
		const levels = await levelsOfTheModel()
		vi.stubEnv('NAMZU_EFFORT_LEVEL', levels[1] as string)
		try {
			const call = await sendWith('go', {}, { savedEffort: levels[0] as never })
			expect(call.turnConfig?.effort).toBeUndefined()
		} finally {
			vi.unstubAllEnvs()
		}
	})

	it('is ignored when the model does not offer it, so the model default stands', async () => {
		const levels = await levelsOfTheModel()
		const missing = (
			['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
		).find((level) => !levels.includes(level))
		expect(missing).toBeDefined()
		const call = await sendWith('go', {}, { savedEffort: missing as never })
		expect(call.turnConfig?.effort).toBeUndefined()
	})

	it('sends no level when none is saved', async () => {
		const call = await sendWith('go')
		expect(call.turnConfig?.effort).toBeUndefined()
	})
})
