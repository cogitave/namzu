/**
 * The `workflow` tool is in the model's tool list on every turn of a host that
 * can run one (the model is gated by the opt-in rule, not by the list), the
 * standing hypermode reaches the model as request-only notes, and a turn with
 * nobody to review a script cannot start one.
 * Driven through the real AgentSession, with the kernel's `query` recorded.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	type ReminderSource,
	type ToolContext,
	type ToolDefinition,
	type Toolset,
	type TurnId,
	createAssistantMessage,
	createRuntimeContextMessage,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { WORKFLOW_DOCTRINE } from '../../integrations/workflows/doctrine.js'
import { hypermodeReminders } from '../../reminders/hypermode.js'
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
	it('lists it on an ordinary request, with the opt-in rule in the system prompt', async () => {
		const call = await sendWith('fix the failing test in cart.ts')
		expect(offered(call)?.name).toBe('workflow')
		expect(offered(call)?.description).toContain('ONLY call it after an explicit opt-in')
		expect(call.systemPrompt ?? '').toContain(WORKFLOW_DOCTRINE)
	})

	it('keeps the system prompt identical whether hypermode is on or off', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		try {
			for (const hypermode of [false, true, false]) {
				for await (const _event of session.send([{ role: 'user', content: 'go', timestamp: 0 }], {
					workflowReview: REVIEWER,
					...(hypermode ? { hypermode: true } : {}),
				})) {
					// drain
				}
			}
		} finally {
			await session.close()
		}
		const [off, on, offAgain] = queryCalls as Array<{
			systemPrompt?: string
			toolsets: readonly Toolset[]
		}>
		expect(on?.systemPrompt).toBe(off?.systemPrompt)
		expect(offAgain?.systemPrompt).toBe(off?.systemPrompt)
		for (const call of [off, on, offAgain]) expect(call && offered(call)).toBeDefined()
	})

	it('tells the model about the standing hypermode in full once, never in the system prompt, and once on exit', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), {
			cwd,
			reminders: true,
		})
		// The conversation the kernel would hold: each send's message, then the
		// reminders it appended to it.
		let history: Message[] = []
		const said: string[][] = []
		try {
			for (const hypermode of [true, true, false, false]) {
				history = [...history, createUserMessage('go')]
				for await (const _event of session.send([...history], {
					workflowReview: REVIEWER,
					...(hypermode ? { hypermode: true } : {}),
				})) {
					// drain
				}
				const call = queryCalls.at(-1) as { reminders?: ReminderSource } | undefined
				const reminders = [...((await call?.reminders?.({ messages: history } as never)) ?? [])]
				said.push(reminders)
				history = [
					...history,
					...reminders.map((text) => createRuntimeContextMessage(text, 'reminder')),
				]
			}
		} finally {
			await session.close()
		}
		const calls = queryCalls as Array<{ systemPrompt?: string }>
		expect(said[0]?.join('\n')).toContain('Hypermode is on: optimize for the most exhaustive')
		expect(said[0]?.join('\n')).toContain('Use the `workflow` tool on every substantive task')
		expect(said[1]).toEqual([])
		expect(said[2]?.join('\n')).toContain('Hypermode is off')
		expect(said[3]).toEqual([])
		for (const call of calls) expect(call.systemPrompt ?? '').not.toContain('Hypermode is on')
	})

	it('does not repeat the full text to a resumed conversation that already heard it', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		const heard = hypermodeReminders({
			messages: [createUserMessage('earlier')],
			on: true,
			toolListed: true,
		})
		const resumed: Message[] = [
			createUserMessage('earlier'),
			...heard.map((text) => createRuntimeContextMessage(text, 'reminder')),
			createAssistantMessage('ok'),
			createUserMessage('after the resume'),
		]
		try {
			for await (const _event of session.send(resumed, {
				workflowReview: REVIEWER,
				hypermode: true,
			})) {
				// drain
			}
		} finally {
			await session.close()
		}
		const call = queryCalls[0] as { reminders?: ReminderSource } | undefined
		const said = (await call?.reminders?.({ messages: resumed } as never)) ?? []
		expect(said.filter((text) => text.includes('Hypermode'))).toEqual([])
	})

	it('says the exit text for a conversation that was told "on", on a host with no other reminders', async () => {
		const { createAgentSession } = await import('../agent.js')
		// No `reminders` option: the shape of a headless run.
		const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		const heard = hypermodeReminders({
			messages: [createUserMessage('earlier')],
			on: true,
			toolListed: true,
		})
		const history: Message[] = [
			createUserMessage('earlier'),
			...heard.map((text) => createRuntimeContextMessage(text, 'reminder')),
			createAssistantMessage('ok'),
			createUserMessage('now without the mode'),
		]
		try {
			for await (const _event of session.send(history, { workflowReview: REVIEWER })) {
				// drain
			}
		} finally {
			await session.close()
		}
		const call = queryCalls[0] as { reminders?: ReminderSource } | undefined
		const said = (await call?.reminders?.({ messages: history } as never)) ?? []
		expect(said.join('\n')).toContain('Hypermode is off')
	})

	it('says nothing of hypermode to a headless conversation that never heard it', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), { cwd })
		try {
			for await (const _event of session.send([createUserMessage('hello')], {
				workflowReview: REVIEWER,
			})) {
				// drain
			}
		} finally {
			await session.close()
		}
		const call = queryCalls[0] as { reminders?: ReminderSource } | undefined
		const said =
			(await call?.reminders?.({ messages: [createUserMessage('hello')] } as never)) ?? []
		expect(said.filter((text) => text.includes('Hypermode'))).toEqual([])
	})

	it('tells a host that cannot start a workflow to use parallel agents instead', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), {
			cwd,
		})
		try {
			for await (const _event of session.send([{ role: 'user', content: 'go', timestamp: 0 }], {
				hypermode: true,
			})) {
				// drain
			}
		} finally {
			await session.close()
		}
		const [call] = queryCalls as Array<{
			toolsets: readonly Toolset[]
			reminders?: ReminderSource
		}>
		expect(call && offered(call)).toBeUndefined()
		const said = (await call?.reminders?.({ messages: [createUserMessage('go')] } as never)) ?? []
		const text = said.find((entry) => entry.includes('Hypermode'))
		expect(text).toContain('not available in this run')
		expect(text).toContain('`Agent`')
	})

	it('lists it for the slash command and the armed trigger too', async () => {
		for (const [text, extra] of [
			['use a workflow to audit the packages', { workflow: true }],
			['Use a workflow for this: audit it', {}],
		] as const) {
			queryCalls.length = 0
			const call = await sendWith(text, extra)
			expect(offered(call)?.description).toContain('export const meta')
		}
	})

	it('does not list it to a host that passes no workflow reviewer', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(preferences, detectedAnthropic(), {
			cwd,
		})
		try {
			for await (const _event of session.send(
				[{ role: 'user', content: 'use a workflow', timestamp: 0 }],
				{ workflow: true, hypermode: true },
			)) {
				// drain
			}
		} finally {
			await session.close()
		}
		const [call] = queryCalls as {
			toolsets: readonly Toolset[]
			systemPrompt?: string
		}[]
		expect(call && offered(call)).toBeUndefined()
		expect(call?.systemPrompt ?? '').not.toContain(WORKFLOW_DOCTRINE)
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
		await sendWith('use a workflow', { workflow: true, ...options })
		return result
	}

	it('refuses, in plain words, a headless turn that is not set to run without asking', async () => {
		const result = await attempt({
			permissionMode: 'prompt',
			workflowReview: { currentPermissionMode: () => 'prompt' },
		})
		expect(result?.success).toBe(false)
		expect(result?.error).toContain('nobody to ask')
		expect(result?.error).toContain('--permission-mode bypass')
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
		const call = await sendWith('use a workflow', {
			permissionMode: 'auto',
			workflow: true,
		})
		const result = await offered(call)?.execute({ script }, {
			turnId: call.turnId,
			abortSignal: new AbortController().signal,
		} as ToolContext)
		expect(result?.error).toBe('This reply cannot start a workflow.')
	})
})
