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
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
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
			sessionId: 'ses_policy' as SessionId,
			topicId: 'top_policy' as TopicId,
			projectId: 'prj_policy' as ProjectId,
			tenantId: 'tnt_policy' as TenantId,
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
			sessionId: 'ses_plan_policy' as SessionId,
			topicId: 'top_plan_policy' as TopicId,
			projectId: 'prj_plan_policy' as ProjectId,
			tenantId: 'tnt_plan_policy' as TenantId,
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
