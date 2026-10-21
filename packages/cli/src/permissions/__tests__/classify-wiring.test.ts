/**
 * The auto mode as the CLI wires it: a real kernel turn, a scripted classifier,
 * and the CLI's own review handler in `classify`. No model is called and
 * nothing waits on a clock.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type AutoReviewClassifier,
	type AutoReviewDecision,
	type AutoReviewRequest,
	BashTool,
	MockLLMProvider,
	type ProjectId,
	type ResumeContext,
	type ResumeHandler,
	type SessionId,
	type TenantId,
	type TopicId,
	createUserMessage,
	query,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type PermissionFn, type ReviewExtras, makeResumeHandler } from '../../tui/agent.js'
import { createLiveModeControl } from '../live-mode.js'
import type { PermissionMode } from '../mode.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const allow: AutoReviewDecision = { verdict: 'allow', stage: 1, latencyMs: 0 }
const block = (reason: string, limitReached?: 'consecutive' | 'total'): AutoReviewDecision => ({
	verdict: 'block',
	cause: 'rule',
	stage: 2,
	reason,
	latencyMs: 0,
	...(limitReached ? { limitReached } : {}),
})

function scripted(answer: (request: AutoReviewRequest) => AutoReviewDecision) {
	// The transcript is the turn's own array and changes after the call, so what
	// the classifier saw is written down at the moment it saw it.
	const seen: (AutoReviewRequest & { readonly shown: string })[] = []
	const classifier: AutoReviewClassifier = {
		review: vi.fn(async (request) => {
			seen.push({ ...request, shown: JSON.stringify(request.transcript) })
			return answer(request)
		}),
		denials: { consecutive: 0, total: 0 },
		reset: () => {},
	}
	return { classifier, seen }
}

async function turn(options: {
	command: string
	mode: PermissionMode
	extras?: ReviewExtras
	onPermission?: PermissionFn | undefined
	userSays?: string
}) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-classify-wiring-'))
	dirs.push(cwd)
	const execute = vi.fn(async () => ({
		success: true,
		output: 'RESULT-THE-CLASSIFIER-MUST-NOT-SEE',
	}))
	const handler = makeResumeHandler(
		{ all: false },
		options.onPermission,
		options.mode,
		() => false,
		{},
		undefined,
		undefined,
		{ roots: () => [cwd], ...options.extras },
	)
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ name: 'bash', args: { command: options.command } }] },
			{ text: 'done' },
		],
	})
	const events: { type?: string; kind?: string }[] = []
	for await (const event of query({
		provider,
		toolsets: [toolset('shell', [{ ...BashTool, execute }])],
		messages: [createUserMessage(options.userSays ?? 'publish it')],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
			permissionMode: 'auto',
		},
		agentId: 'agent_shell',
		agentName: 'Shell',
		workingDirectory: cwd,
		sessionId: '052b7785-2bcc-458a-8184-76dfbdbfdf58' as SessionId,
		topicId: '458174d9-b54f-43a9-9ccc-c3d87be14190' as TopicId,
		projectId: '8e2b818f-eb63-4f6e-a416-18b311dcb61c' as ProjectId,
		tenantId: '36da1973-021d-40d5-9a72-7ba4084729de' as TenantId,
		authorizationGate: {
			enabled: true,
			rules: [],
			allowReadOnlyTools: true,
			denyDangerousPatterns: true,
			logDecisions: false,
		},
		outsideRootAccess: 'review',
		resumeHandler: handler,
		// What `createLiveModeControl` answers with in classify.
		reviewAllowedCalls: () => true,
	} as never)) {
		events.push(event as never)
	}
	return { execute, provider, events }
}

describe('the classifier is asked through the real handler', () => {
	it('lets a call the classifier allows run, and asks about the call as the model made it', async () => {
		const { classifier, seen } = scripted(() => allow)

		const { execute } = await turn({
			command: 'gh pr create --fill',
			mode: 'classify',
			extras: { classifier },
		})

		expect(seen).toHaveLength(1)
		expect(seen[0]?.call).toMatchObject({ name: 'bash', input: { command: 'gh pr create --fill' } })
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('hands the classifier the conversation the kernel offers, through every wrapper', async () => {
		const { classifier, seen } = scripted(() => allow)
		const conversation = [createUserMessage('open a pull request for this branch')]
		const control = createLiveModeControl({
			initial: 'classify',
			handlerFor: (mode) =>
				makeResumeHandler({ all: false }, undefined, mode, () => false, {}, undefined, undefined, {
					roots: () => ['/work'],
					classifier,
				}),
		})

		await control.handler(
			{
				type: 'tool_review',
				sessionId: '052b7785-2bcc-458a-8184-76dfbdbfdf58',
				turnId: '64e436d8-4c5f-46f7-b3fb-35ca1a31a891',
				checkpointId: '45a5d18a-3a8a-48a4-9274-bd2a85ba7e18',
				toolCalls: [
					{
						id: 'c1',
						name: 'bash',
						input: { command: 'gh pr create --fill' },
						isDestructive: false,
						authorization: { decision: 'review' },
					},
				],
			} as never,
			{ transcript: () => conversation },
		)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.transcript).toBe(conversation)
	})

	it('tells the model the reason for a block and runs nothing', async () => {
		const { classifier } = scripted(() => block('it would publish the package'))

		const { execute, provider } = await turn({
			command: 'npm publish',
			mode: 'classify',
			extras: { classifier },
		})

		expect(execute).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain(
			'Blocked by auto mode: it would publish the package',
		)
	})

	it('does not put an ordinary read to the classifier', async () => {
		const { classifier, seen } = scripted(() => block('never'))

		const { execute } = await turn({
			command: 'cat README.md',
			mode: 'classify',
			extras: { classifier },
		})

		expect(seen).toHaveLength(0)
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('still asks a person about what no mode may approve in advance', async () => {
		const { classifier, seen } = scripted(() => allow)
		const asked = vi.fn<PermissionFn>(async () => ({ kind: 'reject', feedback: 'no' }))

		const { execute } = await turn({
			command: 'rm -rf ~',
			mode: 'classify',
			extras: { classifier },
			onPermission: asked,
		})

		expect(asked).toHaveBeenCalledTimes(1)
		expect(seen).toHaveLength(0)
		expect(execute).not.toHaveBeenCalled()
	})
})

describe('when the classifier stops being trusted', () => {
	it('tells the host, which changes the mode, and asks the person about the call that tripped it', async () => {
		const { classifier } = scripted(() => block('third in a row', 'consecutive'))
		const onClassifierLimit = vi.fn()
		const asked = vi.fn<PermissionFn>(async () => ({ kind: 'approve' }))

		const { execute } = await turn({
			command: 'npm publish',
			mode: 'classify',
			extras: { classifier, onClassifierLimit },
			onPermission: asked,
		})

		expect(onClassifierLimit).toHaveBeenCalledWith({
			limit: 'consecutive',
			reason: 'third in a row',
		})
		expect(asked).toHaveBeenCalledTimes(1)
		expect(execute).toHaveBeenCalledTimes(1)
	})

	it('ends the turn when nobody can be asked', async () => {
		const { classifier } = scripted(() => block('twentieth block', 'total'))
		const onClassifierLimit = vi.fn()

		const { execute, provider } = await turn({
			command: 'npm publish',
			mode: 'classify',
			extras: { classifier, onClassifierLimit },
		})

		expect(onClassifierLimit).toHaveBeenCalledOnce()
		expect(execute).not.toHaveBeenCalled()
		// The model is never given a second go: the turn ended on the abort.
		expect(provider.requests).toHaveLength(1)
	})
})

describe('a classify handler without a classifier', () => {
	it('asks when a person can be asked, and refuses when not, never approves', async () => {
		const asked = vi.fn<PermissionFn>(async () => ({ kind: 'reject', feedback: 'no' }))
		const attended = await turn({ command: 'npm publish', mode: 'classify', onPermission: asked })
		expect(asked).toHaveBeenCalledTimes(1)
		expect(attended.execute).not.toHaveBeenCalled()

		const unattended = await turn({ command: 'npm publish', mode: 'classify' })
		expect(unattended.execute).not.toHaveBeenCalled()
	})
})

describe('the live-mode wrapper', () => {
	it('hands the kernel’s second argument to the handler it picked', async () => {
		let received: ResumeContext | undefined
		const control = createLiveModeControl({
			initial: 'classify',
			handlerFor: () => async (_request, context) => {
				received = context
				return { action: 'approve_tools' }
			},
		})
		const context: ResumeContext = { transcript: () => [] }

		await (control.handler as ResumeHandler)({ type: 'tool_review' } as never, context)

		expect(received).toBe(context)
	})

	it('asks for allowed calls to be reviewed in plan and classify, and nowhere else', () => {
		const answers = (mode: PermissionMode) =>
			createLiveModeControl({
				initial: mode,
				handlerFor: () => async () => ({ action: 'approve_tools' }),
			}).reviewAllowedCalls()

		expect(
			(['prompt', 'accept-edits', 'plan', 'bypass', 'classify', 'strict', 'auto'] as const).map(
				answers,
			),
		).toEqual([false, false, true, false, true, false, false])
	})
})
