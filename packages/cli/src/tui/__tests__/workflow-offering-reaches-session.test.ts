/**
 * The `workflow` tool is in the model's tool list only when the operator asked
 * for orchestration, and a turn with nobody to review it cannot start one.
 * Driven through the real AgentSession, with the kernel's `query` recorded.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext, ToolDefinition, Toolset, TurnId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { WORKFLOW_DOCTRINE } from '../../integrations/workflows/doctrine.js'
import type { SendOptions } from '../agent.js'

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

async function sendWith(text: string, options: SendOptions = {}) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
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
	return queryCalls[0] as { toolsets: readonly Toolset[]; systemPrompt?: string; turnId: TurnId }
}

function offered(call: { toolsets: readonly Toolset[] }): ToolDefinition | undefined {
	for (const toolset of call.toolsets) {
		const found = toolset.tools().find((tool) => tool.name === 'workflow')
		if (found) return found
	}
	return undefined
}

describe('when the model is offered the workflow tool', () => {
	it('does not offer it to an ordinary request', async () => {
		const call = await sendWith('fix the failing test in cart.ts')
		expect(offered(call)).toBeUndefined()
		expect(call.systemPrompt ?? '').not.toContain(WORKFLOW_DOCTRINE)
	})

	it.each([
		['the message says workflow', 'use a workflow to audit the packages', {}],
		['the message says iş akışı', 'bir iş akışı kur', {}],
		['the slash command was used', 'Use a workflow for this: audit it', {}],
		['hypermode is on', 'audit the packages', { hypermode: true }],
	])('offers it when %s, with the doctrine that goes with it', async (_why, text, extra) => {
		const call = await sendWith(text, extra)
		const tool = offered(call)
		expect(tool?.name).toBe('workflow')
		expect(tool?.description).toContain('export const meta')
		expect(call.systemPrompt ?? '').toContain(WORKFLOW_DOCTRINE)
	})

	it.each([
		['the message asks for one', 'use a workflow to audit', {}],
		['hypermode is on', 'audit the packages', { hypermode: true }],
	])(
		'does not offer it to a host that passes no workflow reviewer, even when %s',
		async (_why, text, extra) => {
			const { createAgentSession } = await import('../agent.js')
			const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
			try {
				for await (const _event of session.send(
					[{ role: 'user', content: text, timestamp: 0 }],
					extra,
				)) {
					// drain
				}
			} finally {
				await session.close()
			}
			const [call] = queryCalls as { toolsets: readonly Toolset[]; systemPrompt?: string }[]
			expect(call && offered(call)).toBeUndefined()
			expect(call?.systemPrompt ?? '').not.toContain(WORKFLOW_DOCTRINE)
		},
	)

	it('offers it on the turn that asked, not on the next one', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		try {
			for (const text of ['use a workflow', 'thanks, now rename the file']) {
				for await (const _event of session.send([{ role: 'user', content: text, timestamp: 0 }], {
					workflowReview: REVIEWER,
				})) {
					// drain
				}
			}
		} finally {
			await session.close()
		}
		const [first, second] = queryCalls as Array<{ toolsets: readonly Toolset[] }>
		expect(first && offered(first)).toBeDefined()
		expect(second && offered(second)).toBeUndefined()
	})
})

describe('who may start one', () => {
	const script = "const n = 'x'\nexport const meta = { name: n, description: 'y' }"

	/** Calls the tool the way the kernel would, mid-turn, and returns what it said. */
	async function attempt(options: SendOptions) {
		let result: { success: boolean; error?: string } | undefined
		duringTurn.current = async (params) => {
			const tool = offered(params as { toolsets: readonly Toolset[] })
			result = await tool?.execute({ script }, {
				turnId: params.turnId,
				abortSignal: new AbortController().signal,
			} as ToolContext)
		}
		await sendWith('use a workflow', options)
		return result
	}

	it('refuses, in plain words, a headless turn that is not set to run without asking', async () => {
		const result = await attempt({
			permissionMode: 'prompt',
			workflowReview: { currentPermissionMode: () => 'prompt' },
		})
		expect(result?.success).toBe(false)
		expect(result?.error).toContain('nobody to ask')
		expect(result?.error).toContain('--permission-mode auto')
	})

	it('lets a turn with a reviewer past the gate (the script is then judged on its own)', async () => {
		const result = await attempt({ permissionMode: 'prompt' })
		expect(result?.success).toBe(false)
		expect(result?.error).not.toContain('nobody to ask')
		expect(result?.error).toMatch(/meta/i)
	})

	it('lets a bypass session past the gate with nobody there', async () => {
		const result = await attempt({
			permissionMode: 'auto',
			workflowReview: { currentPermissionMode: () => 'auto' },
		})
		expect(result?.error).not.toContain('nobody to ask')
		expect(result?.error).toMatch(/meta/i)
	})

	it('has no authority once the turn is over', async () => {
		const call = await sendWith('use a workflow', { permissionMode: 'auto' })
		const result = await offered(call)?.execute({ script }, {
			turnId: call.turnId,
			abortSignal: new AbortController().signal,
		} as ToolContext)
		expect(result?.error).toBe('This turn cannot start a workflow.')
	})
})
