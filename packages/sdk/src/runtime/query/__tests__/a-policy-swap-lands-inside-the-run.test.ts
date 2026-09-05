import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import type { RunApprovalPolicy } from '../../../types/hitl/policy.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { isEntityId } from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The swap has to land INSIDE the run, or none of it matters.
 *
 * The box, its event and its ordering are unit-tested next door. What is
 * left is the claim the whole task rests on: that `query` reads through the
 * box on every question rather than through the handler it was handed, and
 * that a host can get hold of that box in the first place.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function runWithPolicy(opts: {
	approvalPolicyName?: string
	onPolicy?: (policy: RunApprovalPolicy) => void
	handler?: () => Promise<{ action: 'continue' }>
	turns?: unknown[]
}): Promise<{ events: RunEvent[] }> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-policy-'))
	dirs.push(workingDirectory)
	const tools = new ToolRegistry()
	tools.register(BashTool)
	const events: RunEvent[] = []

	await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: (opts.turns ?? [{ text: 'nothing to do' }]) as never,
			}),
			tools,
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: 'c9f62215-4bcb-4422-bf4b-0641739f0eed' as SessionId,
			topicId: 'e98cb45c-0a26-41d5-a1e0-7682e6004ca9' as TopicId,
			projectId: '65447df7-304f-4d22-be65-21a94b7ea116' as ProjectId,
			tenantId: 'd35d280f-53b3-49be-beb7-2b33ad45366b' as TenantId,
			...(opts.approvalPolicyName ? { approvalPolicyName: opts.approvalPolicyName } : {}),
			...(opts.onPolicy ? { onApprovalPolicy: opts.onPolicy } : {}),
			...(opts.handler ? { resumeHandler: opts.handler } : {}),
		},
		(event) => {
			events.push(event)
		},
	)

	return { events }
}

describe('a host can reach the run’s policy box', () => {
	it('is handed one', async () => {
		let seen: RunApprovalPolicy | undefined
		await runWithPolicy({
			onPolicy: (policy) => {
				seen = policy
			},
		})

		expect(seen).toBeDefined()
		expect(typeof seen?.set).toBe('function')
	})

	it('names an unattended run `auto-approve`, not `host`', async () => {
		// By identity against the default handler, not by presence.
		// `resumeHandler` is REQUIRED on QueryParams — `drainQuery` substitutes
		// the auto-approve default — so "is it set" is always yes and would
		// name every run `host`, including the ones approving everything
		// unattended.
		let seen: RunApprovalPolicy | undefined
		await runWithPolicy({
			onPolicy: (policy) => {
				seen = policy
			},
		})

		expect(seen?.current.name).toBe('auto-approve')
	})

	it('names a run with a real handler `host` by default', async () => {
		let seen: RunApprovalPolicy | undefined
		await runWithPolicy({
			onPolicy: (policy) => {
				seen = policy
			},
			handler: async () => ({ action: 'continue' }),
		})

		expect(seen?.current.name).toBe('host')
	})

	it('takes the name the host gave it', async () => {
		let seen: RunApprovalPolicy | undefined
		await runWithPolicy({
			approvalPolicyName: 'operator-tui',
			onPolicy: (policy) => {
				seen = policy
			},
			handler: async () => ({ action: 'continue' }),
		})

		expect(seen?.current.name).toBe('operator-tui')
	})
})

describe('a change made during the run reaches the run’s event stream', () => {
	it('emits approval_policy_changed to the run’s listener', async () => {
		// Not to a side channel. This is the log a review reads, and a policy
		// change that only a host-local callback saw is a change nobody can
		// reconstruct afterwards.
		const { events } = await runWithPolicy({
			approvalPolicyName: 'operator-tui',
			handler: async () => ({ action: 'continue' }),
			onPolicy: (policy) => {
				void policy.set(
					{ name: 'auto-approve', handler: async () => ({ action: 'continue' }) },
					'operator stepped away',
				)
			},
		})

		const changed = events.filter((e) => e.type === 'approval_policy_changed')
		expect(changed).toHaveLength(1)
		expect(changed[0]).toMatchObject({
			from: 'operator-tui',
			to: 'auto-approve',
			reason: 'operator stepped away',
		})
	})

	it('emits nothing when the policy is left alone', async () => {
		const { events } = await runWithPolicy({ handler: async () => ({ action: 'continue' }) })

		expect(events.filter((e) => e.type === 'approval_policy_changed')).toHaveLength(0)
	})
})

describe('the swap reaches the places that actually ask a human', () => {
	it('the SECOND tool review is answered by the NEW handler', async () => {
		// The claim the whole task rests on, and the one two mutations
		// survived on before this existed: swapping the box means nothing if
		// the executor is still holding the handler it was handed at start.
		const answeredBy: string[] = []
		let policyBox: RunApprovalPolicy | undefined

		const first = async () => {
			answeredBy.push('first')
			// Swap on the way out of the first question, so the second one is
			// the first thing the new policy sees.
			await policyBox?.set(
				{
					name: 'second',
					handler: async () => {
						answeredBy.push('second')
						return { action: 'continue' } as const
					},
				},
				'operator handed over',
			)
			return { action: 'continue' } as const
		}

		await runWithPolicy({
			approvalPolicyName: 'first',
			handler: first,
			onPolicy: (policy) => {
				policyBox = policy
			},
			turns: [
				{ toolCalls: [{ id: 't1', name: 'bash', args: { command: 'echo one', timeout: 1000 } }] },
				{ toolCalls: [{ id: 't2', name: 'bash', args: { command: 'echo two', timeout: 1000 } }] },
				{ text: 'done' },
			],
		})

		// The shape, not an exact count: how many reviews a run raises is the
		// review phase's business and not what this is about. What matters is
		// that `first` answered exactly once — the question that was in flight
		// when the swap happened — and every question after it went to
		// `second`. Held as `['first', ...'second']` rather than a fixed
		// length, so a change in review cadence does not fail this for the
		// wrong reason.
		expect(answeredBy.length).toBeGreaterThan(1)
		expect(answeredBy[0]).toBe('first')
		expect(answeredBy.filter((who) => who === 'first')).toHaveLength(1)
		expect(answeredBy.slice(1).every((who) => who === 'second')).toBe(true)
	})
})

describe('the swap reaches PLAN approval too, which is the other place a human is asked', () => {
	it('correlates repeated plan review through one opaque approval ID', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-plan-identity-'))
		dirs.push(workingDirectory)
		let plans: PlanManager | undefined
		const seen: Array<{ checkpointId: string; planId: string | undefined }> = []
		await drainQuery({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] as never }),
			tools: new ToolRegistry(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: '2086aad0-73a2-4d64-a0b0-74622bcb7f60' as SessionId,
			topicId: '845dc567-2c9a-4fc8-912b-891106561049' as TopicId,
			projectId: 'c365f50c-5ba4-48e4-a8ea-7ce5a2d3d567' as ProjectId,
			tenantId: 'c2c369d4-f48f-4649-97aa-b22c76d5cd6c' as TenantId,
			resumeHandler: async (request) => {
				if (request.type === 'plan_approval') {
					seen.push({ checkpointId: request.checkpointId, planId: request.plan?.planId })
				}
				return { action: 'approve_plan' }
			},
			onContextCreated: ({ planManager }) => {
				plans = planManager
			},
		})
		if (!plans) throw new Error('plan manager was not created')
		plans.startGenerating('first plan')
		plans.addStep({ id: 'step_1', description: 'the work', dependsOn: [], order: 1 })
		plans.markReady()
		await plans.requestApproval()
		await plans.requestApproval()
		plans.startGenerating('another plan')
		plans.addStep({ id: 'step_1', description: 'different work', dependsOn: [], order: 1 })
		plans.markReady()
		await plans.requestApproval()
		expect(seen).toHaveLength(3)
		expect(seen[0]).toEqual(seen[1])
		expect(isEntityId(seen[0]?.checkpointId, 'checkpoint')).toBe(true)
		expect(seen[0]?.checkpointId).not.toContain('_')
		expect(seen[0]?.checkpointId).not.toBe(seen[0]?.planId)
		expect(seen[2]?.checkpointId).not.toBe(seen[0]?.checkpointId)
	})

	it('a plan raised after the swap is answered by the new handler', async () => {
		// The second of the two call sites, and the one a mutation survived on
		// after the executor was covered. They are wired independently, so
		// covering one proves nothing about the other — the same shape as the
		// `taskSucceeded` omission this repo already has a note about: a review
		// caught one site, and nothing carried the answer to the other.
		//
		// Driven AFTER `drainQuery` returns rather than from inside a hook.
		// `onContextCreated` fires before the box is handed out — the handout
		// waits for `run_started`, so that the durable record of a change can
		// actually be written — so a host cannot reach the box from there.
		// Both objects outlive the run, and the question this asks is about
		// the wiring, not about timing.
		const answeredBy: string[] = []
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-policy-plan-'))
		dirs.push(workingDirectory)
		let policyBox: RunApprovalPolicy | undefined
		let plans: PlanManager | undefined

		await drainQuery({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] as never }),
			tools: new ToolRegistry(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: '37c63932-bd3a-4ece-84b9-3324894ab5a1' as SessionId,
			topicId: '2490e6c1-c7a8-4952-85ad-166e3a758f1e' as TopicId,
			projectId: '7385d62d-10d0-4f3a-9d78-1e18daed201d' as ProjectId,
			tenantId: '76dabd8f-89f6-4a09-bdb2-516b5ac3ce04' as TenantId,
			approvalPolicyName: 'first',
			resumeHandler: async () => {
				answeredBy.push('first')
				return { action: 'continue' }
			},
			onApprovalPolicy: (policy) => {
				policyBox = policy
			},
			onContextCreated: ({ planManager }) => {
				plans = planManager
			},
		})

		await policyBox?.set(
			{
				name: 'second',
				handler: async () => {
					answeredBy.push('second')
					return { action: 'approve_plan' }
				},
			},
			'operator handed over',
		)

		plans?.startGenerating('the work')
		plans?.addStep({ id: 'step_1', description: 'first', dependsOn: [], order: 1 })
		plans?.markReady()
		const response = await plans?.requestApproval()

		// Not 'first'. The plan manager was wired to the BOX, not to the
		// handler that was current when it was wired.
		expect(answeredBy).toEqual(['second'])
		expect(response?.approved).toBe(true)
	})
})

describe('the model is told, in the slot it already reads', () => {
	it('carries the notice on the request AFTER the swap, and only that one', async () => {
		// The model plans around how closely it is watched. A run that
		// silently stops asking a human leaves it batching destructive calls
		// it expects to be reviewed; one that silently starts leaves it
		// waiting on permission nobody is left to give.
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-policy-notice-'))
		dirs.push(workingDirectory)
		const tools = new ToolRegistry()
		tools.register(BashTool)
		let policyBox: RunApprovalPolicy | undefined
		let swapped = false

		class Capturing extends MockLLMProvider {
			readonly systemTexts: string[] = []
			override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				const messages = params.messages as { role: string; content: unknown }[]
				this.systemTexts.push(
					messages
						.filter((m) => m.role === 'system' && typeof m.content === 'string')
						.map((m) => m.content as string)
						.join('\n'),
				)
				yield* super.chatStream(params)
			}
		}

		const provider = new Capturing({
			turns: [
				{ toolCalls: [{ id: 't1', name: 'bash', args: { command: 'echo a', timeout: 1000 } }] },
				{ toolCalls: [{ id: 't2', name: 'bash', args: { command: 'echo b', timeout: 1000 } }] },
				{ text: 'done' },
			] as never,
		})

		await drainQuery({
			provider,
			tools,
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: '583b6d3c-84cc-445a-9ca8-a2c1e32366d3' as SessionId,
			topicId: '5ee6a9c6-a3aa-4ee3-9cbc-70c98338891d' as TopicId,
			projectId: '1204c15f-ba7e-4eb8-916b-1563d171f792' as ProjectId,
			tenantId: '0c389376-b0c4-493a-afad-92fe57893ecf' as TenantId,
			approvalPolicyName: 'operator-tui',
			resumeHandler: async () => {
				if (!swapped) {
					swapped = true
					await policyBox?.set(
						{ name: 'auto-approve', handler: async () => ({ action: 'continue' }) },
						'operator stepped away',
					)
				}
				return { action: 'continue' }
			},
			onApprovalPolicy: (policy) => {
				policyBox = policy
			},
		})

		const mentions = provider.systemTexts.filter((text) => text.includes('Approval policy changed'))
		// Exactly once. A notice repeated every iteration reads as
		// supervision moving again on each turn.
		expect(mentions).toHaveLength(1)
		expect(mentions[0]).toContain('from "operator-tui" to "auto-approve"')
		expect(mentions[0]).toContain('operator stepped away')
	})

	it('says nothing to a run whose policy never moved', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-policy-quiet-'))
		dirs.push(workingDirectory)
		const systemTexts: string[] = []

		class Capturing extends MockLLMProvider {
			override async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				const messages = params.messages as { role: string; content: unknown }[]
				systemTexts.push(
					messages
						.filter((m) => m.role === 'system' && typeof m.content === 'string')
						.map((m) => m.content as string)
						.join('\n'),
				)
				yield* super.chatStream(params)
			}
		}

		await drainQuery({
			provider: new Capturing({ turns: [{ text: 'done' }] as never }),
			tools: new ToolRegistry(),
			runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 2 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go')],
			workingDirectory,
			sessionId: '89ff75cc-90b4-49db-b3c6-f672e229b735' as SessionId,
			topicId: '0467c77f-0c41-422f-8216-2b2bc1f8ad3d' as TopicId,
			projectId: 'a421164d-2bee-4b32-bb25-2d5b7786a2a9' as ProjectId,
			tenantId: 'd9579c33-fd15-471d-81a2-2808e12853c5' as TenantId,
			resumeHandler: async () => ({ action: 'continue' }),
		})

		expect(systemTexts.some((t) => t.includes('Approval policy changed'))).toBe(false)
	})
})
