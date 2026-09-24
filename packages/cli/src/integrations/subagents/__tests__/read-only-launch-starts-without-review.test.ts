/**
 * A read-only agent on the session's own model starts without the "Start an
 * agent" question in `prompt` mode; everything else is asked about as before.
 *
 * Two halves, both through real code:
 *
 * - the launch decision, through the handler `createAgentSession` builds
 *   (`makeResumeHandler` over `reviewExemptionFor`) and the runtime's own
 *   `launchesReadOnlyAgent`, in each mode;
 * - what starting such a child grants, which is nothing: a child that is
 *   read-only by its file and asks to write gets no `write` to call, and the
 *   file is never created.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	AuthorizationGate,
	type HITLDecisionRequest,
	MockLLMProvider,
	NOOP_LOGGER,
	type SessionId,
	type ToolCallSummary,
	type ToolContext,
	ToolManager,
	type Toolset,
	asTurnId,
	getBuiltinTools,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import type { PermissionMode } from '../../../permissions/mode.js'
import { compilePermissions } from '../../../permissions/rules.js'
import {
	AGENT_LAUNCH_TOOL,
	type PermissionDecision,
	makeResumeHandler,
	reviewExemptionFor,
} from '../../../tui/agent.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import type { AgentFileDefinition } from '../definitions.js'
import { createSubagentRuntime } from '../runtime.js'

const TURN = asTurnId('7a0b4c1e-2f3d-4e5a-8b6c-9d0e1f2a3b4c')
const SESSION = '3e2d1c0b-4a59-4867-9f8e-7d6c5b4a3e2f' as SessionId
const workdirs: string[] = []

afterEach(() => {
	for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	vi.restoreAllMocks()
})

const auditor: AgentFileDefinition = {
	name: 'auditor',
	description: 'Reads and reports; changes nothing.',
	prompt: 'AUDITOR',
	readOnly: true,
	path: '/p/.namzu/agents/auditor.md',
	source: 'project',
}
const pinnedAuditor: AgentFileDefinition = {
	...auditor,
	name: 'pinned-auditor',
	model: 'another-model',
	path: '/p/.namzu/agents/pinned-auditor.md',
}
const fixer: AgentFileDefinition = {
	...auditor,
	name: 'fixer',
	readOnly: false,
	path: '/p/.namzu/agents/fixer.md',
}
/** A project file that reuses the built-in read-only name and is not read-only. */
const shadowExplore: AgentFileDefinition = {
	...auditor,
	name: 'explore',
	readOnly: false,
	path: '/p/.namzu/agents/explore.md',
}

function builtins(): readonly Toolset[] {
	return [toolset('test', getBuiltinTools())]
}

async function runtimeWith(
	cwd: string,
	definitions: readonly AgentFileDefinition[],
	provider = () => new MockLLMProvider({ turns: [] }),
	resolveResumeHandler?: Parameters<typeof createSubagentRuntime>[0]['resolveResumeHandler'],
) {
	const parent = await subagentParentFixture(cwd, TURN)
	return createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd,
		model: 'session-model',
		buildProvider: provider,
		buildTools: builtins,
		definitions,
		...(resolveResumeHandler ? { resolveResumeHandler } : {}),
	})
}

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-readonly-launch-'))
	workdirs.push(dir)
	return dir
}

const launch = (input: Record<string, unknown>, over: Partial<ToolCallSummary> = {}) =>
	({
		id: `call_${Math.random().toString(36).slice(2)}`,
		name: AGENT_LAUNCH_TOOL,
		input: { description: 'look', prompt: 'look around', ...input },
		isDestructive: false,
		...over,
	}) satisfies ToolCallSummary

const review = (toolCalls: ToolCallSummary[]): HITLDecisionRequest =>
	({
		type: 'tool_review',
		sessionId: SESSION,
		turnId: TURN,
		checkpointId: 'cp_1',
		toolCalls,
	}) as unknown as HITLDecisionRequest

describe('launchesReadOnlyAgent', () => {
	it('names explore and a readOnly agent file on the session model, and nothing else', async () => {
		const runtime = await runtimeWith(workdir(), [auditor, pinnedAuditor, fixer])
		try {
			const readOnly = (input: Record<string, unknown>) =>
				runtime.launchesReadOnlyAgent({
					description: 'd',
					prompt: 'p',
					...input,
				})

			expect(readOnly({ subagent_type: 'explore' })).toBe(true)
			expect(readOnly({ subagent_type: 'explore', role: 'You audit.' })).toBe(true)
			expect(readOnly({ subagent_type: 'auditor' })).toBe(true)
			expect(readOnly({ subagent_type: 'explore', model: 'session-model' })).toBe(true)

			expect(readOnly({}), 'general-purpose by default').toBe(false)
			expect(readOnly({ subagent_type: 'general-purpose' })).toBe(false)
			expect(readOnly({ subagent_type: 'fixer' })).toBe(false)
			expect(readOnly({ subagent_type: 'explore', model: 'other-model' })).toBe(false)
			expect(
				readOnly({
					subagent_type: 'explore',
					model: 'session-model',
					provider: 'openrouter',
				}),
			).toBe(false)
			expect(
				readOnly({
					subagent_type: 'explore',
					model: 'session-model',
					effort: 'high',
				}),
			).toBe(false)
			expect(readOnly({ subagent_type: 'pinned-auditor' }), 'the file picks its own model').toBe(
				false,
			)
			expect(runtime.launchesReadOnlyAgent(undefined)).toBe(false)
			expect(runtime.launchesReadOnlyAgent('explore')).toBe(false)
		} finally {
			await runtime.close()
		}
	})

	it('judges a project file named explore by its own readOnly', async () => {
		const runtime = await runtimeWith(workdir(), [shadowExplore])
		try {
			expect(runtime.launchesReadOnlyAgent({ subagent_type: 'explore' })).toBe(false)
		} finally {
			await runtime.close()
		}
	})
})

describe('the launch decision', () => {
	async function decide(
		mode: PermissionMode,
		calls: ToolCallSummary[],
		definitions: readonly AgentFileDefinition[] = [auditor, fixer],
	) {
		const runtime = await runtimeWith(workdir(), definitions)
		const asked: string[][] = []
		const onPermission = vi.fn(async (request: { toolCalls: readonly ToolCallSummary[] }) => {
			asked.push(
				request.toolCalls.map((call) =>
					String((call.input as { subagent_type?: string }).subagent_type),
				),
			)
			return { kind: 'approve' } as PermissionDecision
		})
		try {
			const handler = makeResumeHandler(
				{ all: false },
				onPermission,
				mode,
				reviewExemptionFor(
					mode,
					new ToolManager({ toolsets: builtins(), messages: () => [] }),
					(input) => runtime.launchesReadOnlyAgent(input),
				),
			)
			const decision = await handler(review(calls))
			return { decision, asked }
		} finally {
			await runtime.close()
		}
	}

	it('starts an explore agent without asking in prompt mode', async () => {
		const { decision, asked } = await decide('prompt', [launch({ subagent_type: 'explore' })])
		expect(decision).toEqual({ action: 'approve_tools' })
		expect(asked).toEqual([])
	})

	it('starts a readOnly agent file without asking in prompt mode', async () => {
		const { decision, asked } = await decide('prompt', [launch({ subagent_type: 'auditor' })])
		expect(decision).toEqual({ action: 'approve_tools' })
		expect(asked).toEqual([])
	})

	it('still asks about an agent that can write', async () => {
		const { asked } = await decide('prompt', [launch({ subagent_type: 'general-purpose' })])
		expect(asked).toEqual([['general-purpose']])
		const file = await decide('prompt', [launch({ subagent_type: 'fixer' })])
		expect(file.asked).toEqual([['fixer']])
	})

	it('still asks about a read-only agent on another provider or model', async () => {
		const provider = await decide('prompt', [
			launch({
				subagent_type: 'explore',
				model: 'session-model',
				provider: 'openrouter',
			}),
		])
		expect(provider.asked).toEqual([['explore']])
		const model = await decide('prompt', [
			launch({ subagent_type: 'explore', model: 'other-model' }),
		])
		expect(model.asked).toEqual([['explore']])
	})

	it('asks about the whole batch when a read-only launch shares it with one that can write', async () => {
		const { asked } = await decide('prompt', [
			launch({ subagent_type: 'explore' }),
			launch({ subagent_type: 'general-purpose' }),
		])
		expect(asked).toEqual([['explore', 'general-purpose']])
	})

	it('asks about every launch under a permissions rule Agent: "ask"', async () => {
		// The way to keep the old behaviour: an `ask` rule is an explicit
		// review, and no exemption skips one.
		const { rules } = compilePermissions({ [AGENT_LAUNCH_TOOL]: 'ask' })
		const gate = new AuthorizationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: true,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			NOOP_LOGGER,
		)
		// A matched `review` rule is what the kernel turns into `explicitReview`.
		expect(
			gate.evaluate({
				toolName: AGENT_LAUNCH_TOOL,
				toolInput: { subagent_type: 'explore' },
				toolDef: undefined,
			}),
		).toMatchObject({
			decision: 'review',
			matchedRule: { decision: 'review' },
		})
		const { asked } = await decide('prompt', [
			launch(
				{ subagent_type: 'explore' },
				{ authorization: { decision: 'review', explicitReview: true } },
			),
		])
		expect(asked).toEqual([['explore']])
	})

	it('lets a read-only agent start in plan mode and refuses one that can write', async () => {
		const readOnly = await decide('plan', [launch({ subagent_type: 'explore' })])
		expect(readOnly.decision).toEqual({ action: 'approve_tools' })
		const writer = await decide('plan', [launch({ subagent_type: 'general-purpose' })])
		expect(writer.decision).toMatchObject({ action: 'reject_tools' })
		expect(writer.asked).toEqual([])
	})

	it('keeps strict mode refusing every launch no rule allows', async () => {
		const { decision, asked } = await decide('strict', [launch({ subagent_type: 'explore' })])
		expect(decision).toMatchObject({ action: 'reject_tools' })
		expect(asked).toEqual([])
	})

	it('starts it without asking in accept-edits mode too', async () => {
		const { decision, asked } = await decide('accept-edits', [launch({ subagent_type: 'explore' })])
		expect(decision).toEqual({ action: 'approve_tools' })
		expect(asked).toEqual([])
	})
})

describe('a child that is read-only by its file', () => {
	it('is refused when it tries to write, and nothing is written', async () => {
		const cwd = workdir()
		const reviewed: string[][] = []
		const runtime = await runtimeWith(
			cwd,
			[auditor],
			() =>
				new MockLLMProvider({
					turns: [
						{
							toolCalls: [
								{
									id: 'w1',
									name: 'write',
									args: { path: 'planted.txt', content: 'x' },
								},
							],
						},
						{ text: 'could not write' },
					],
				}),
			(turnId) =>
				turnId === TURN
					? async (request) => {
							if (request.type === 'tool_review') {
								reviewed.push(request.toolCalls.map((call) => call.name))
							}
							// An operator who approves everything: the refusal must come
							// from the roster, not from a person saying no.
							return request.type === 'tool_review'
								? { action: 'approve_tools' }
								: { action: 'continue' }
						}
					: undefined,
		)
		try {
			const result = await runtime.agentTool.execute(
				{
					description: 'audit',
					prompt: 'write planted.txt',
					subagent_type: 'auditor',
				},
				{
					sessionId: SESSION,
					turnId: TURN,
					abortSignal: new AbortController().signal,
				} as unknown as ToolContext,
			)
			expect(result.success).toBe(true)
			expect(existsSync(join(cwd, 'planted.txt'))).toBe(false)
			// Never even offered for review: the child has no `write` to call.
			expect(reviewed.flat()).not.toContain('write')
			const child = runtime.activity.getSnapshot().find((agent) => agent.agentId === 'auditor')
			const writeRow = child?.transcript.find(
				(row) => row.kind === 'tool' && /write/i.test(row.text),
			)
			if (writeRow && writeRow.kind === 'tool') expect(writeRow.status).toBe('failed')
		} finally {
			await runtime.close()
		}
	})
})

describe('a read-only launch that names the session model', () => {
	it('runs on the session provider and never asks the catalogue to resolve it', async () => {
		// The exemption promises the session's own provider. Resolving the
		// session model could land on another provider that lists the same id
		// whenever the session's own listing fails or omits it.
		const cwd = workdir()
		const parent = await subagentParentFixture(cwd, TURN)
		const resolveModel = vi.fn(async () => ({
			provider: 'openrouter',
			model: 'session-model',
		}))
		const selections: unknown[] = []
		const runtime = await createSubagentRuntime({
			resolveParent: parent.resolveParent,
			cwd,
			model: 'session-model',
			buildProvider: (_sessionId, selection) => {
				selections.push(selection)
				return new MockLLMProvider({ turns: [{ text: 'looked' }] })
			},
			buildTools: builtins,
			definitions: [],
			resolveModel: resolveModel as never,
			resolveResumeHandler: () => async () => ({ action: 'continue' }) as never,
		})
		try {
			const input = {
				description: 'look',
				prompt: 'look around',
				subagent_type: 'explore',
				model: 'session-model',
			}
			expect(runtime.launchesReadOnlyAgent(input)).toBe(true)
			const result = await runtime.agentTool.execute(input, {
				sessionId: SESSION,
				turnId: TURN,
				abortSignal: new AbortController().signal,
			} as unknown as ToolContext)
			expect(result.success).toBe(true)
			expect(resolveModel).not.toHaveBeenCalled()
			expect(selections).toEqual([undefined])
		} finally {
			await runtime.close()
		}
	})

	it('still resolves the session model when a provider is named', async () => {
		const cwd = workdir()
		const parent = await subagentParentFixture(cwd, TURN)
		const resolveModel = vi.fn(async () => ({
			provider: 'openrouter',
			model: 'session-model',
		}))
		const runtime = await createSubagentRuntime({
			resolveParent: parent.resolveParent,
			cwd,
			model: 'session-model',
			buildProvider: () => new MockLLMProvider({ turns: [{ text: 'looked' }] }),
			buildTools: builtins,
			definitions: [],
			resolveModel: resolveModel as never,
			resolveResumeHandler: () => async () => ({ action: 'continue' }) as never,
		})
		try {
			await runtime.agentTool.execute(
				{
					description: 'look',
					prompt: 'look around',
					subagent_type: 'explore',
					model: 'session-model',
					provider: 'openrouter',
				},
				{
					sessionId: SESSION,
					turnId: TURN,
					abortSignal: new AbortController().signal,
				} as unknown as ToolContext,
			)
			expect(resolveModel).toHaveBeenCalledWith(
				{ model: 'session-model', provider: 'openrouter', effort: undefined },
				expect.anything(),
			)
		} finally {
			await runtime.close()
		}
	})
})
