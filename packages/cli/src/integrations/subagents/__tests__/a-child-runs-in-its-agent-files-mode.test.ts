import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type AuthorizationGateConfig,
	MockLLMProvider,
	type ResumeHandler,
	type ToolContext,
	type Toolset,
	asTurnId,
	defineTool,
	mcpJsonSchemaToZod,
	modeReviewsAllowedCalls,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { delegatedAgentMode } from '../../../permissions/delegated-mode.js'
import { createLiveModeControl } from '../../../permissions/live-mode.js'
import type { PermissionMode } from '../../../permissions/mode.js'
import { type PermissionFn, makeResumeHandler } from '../../../tui/agent.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import type { AgentFileDefinition } from '../definitions.js'
import { createSubagentRuntime } from '../runtime.js'

const agentFile: AgentFileDefinition = {
	name: 'worker',
	description: 'Does the work.',
	prompt: 'WORKER-PROMPT',
	readOnly: false,
	path: '/p/.namzu/agents/worker.md',
	source: 'project',
}

/**
 * An agent file's `permissionMode:` narrows its child, never widens it.
 *
 * The child still borrows the invoking turn's review channel. The file's mode
 * is applied to that channel per call, on top of the turn's live mode: a
 * parent that asks takes the file's `plan`; a parent in bypass, plan or
 * accept-edits keeps its own mode whatever the file says; the file cannot ask
 * for bypass.
 */

const TURN = asTurnId('0d44c3f9-a5c4-44ae-a9de-8b9e3e920b32')
const workdirs: string[] = []
afterEach(() => {
	for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	vi.restoreAllMocks()
})

const gate: AuthorizationGateConfig = {
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

const context = (): ToolContext =>
	({
		sessionId: '5c1d7a3e-0b52-4c1f-9d8e-2a6f4b7c9e10',
		turnId: TURN,
		abortSignal: new AbortController().signal,
	}) as ToolContext

/** The parent turn's live handler, in `mode`, and what the person was asked. */
async function childUnder(
	mode: () => PermissionMode,
	declared: string | undefined,
	onFirstCall?: () => void,
) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-mode-'))
	workdirs.push(cwd)
	const asked: string[] = []
	const prompt: PermissionFn = async (request) => {
		asked.push(...request.toolCalls.map((call) => call.name))
		return { kind: 'approve' }
	}
	const classifier = {
		review: vi.fn(async () => ({ verdict: 'allow' as const, stage: 1 as const, latencyMs: 0 })),
		denials: { consecutive: 0, total: 0 },
		reset: () => {},
	}
	const control = createLiveModeControl({
		initial: mode(),
		read: mode,
		handlerFor: (m) =>
			makeResumeHandler({ all: false }, prompt, m, () => false, {}, undefined, undefined, {
				roots: () => [cwd],
				classifier,
			}),
	})
	const handler: ResumeHandler = (request, ctx) => control.handler(request, ctx)
	const tools = (): readonly Toolset[] => [
		toolset('test', [
			defineTool({
				name: 'touch',
				description: 'creates a file',
				inputSchema: mcpJsonSchemaToZod({
					type: 'object',
					properties: { path: { type: 'string' } },
					required: ['path'],
				}),
				category: 'filesystem',
				permissions: [],
				readOnly: false,
				destructive: false,
				concurrencySafe: false,
				execute: async (input) => {
					const { path } = input as { path: string }
					writeFileSync(join(cwd, path), 'x')
					onFirstCall?.()
					return { success: true, output: `created ${path}` }
				},
			}),
		]),
	]
	const parent = await subagentParentFixture(cwd, TURN)
	const runtime = await createSubagentRuntime({
		resolveParent: parent.resolveParent,
		cwd,
		model: 'mock-model',
		buildProvider: () =>
			new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'c1', name: 'touch', args: { path: 'first.txt' } }] },
					{ toolCalls: [{ id: 'c2', name: 'touch', args: { path: 'second.txt' } }] },
					{ text: 'child complete' },
				],
			}),
		buildTools: tools,
		authorizationGate: gate,
		definitions: [{ ...agentFile, ...(declared ? { permissionMode: declared } : {}) }],
		resolveResumeHandler: (turnId) => (turnId === TURN ? handler : undefined),
		resolveReviewAllowedCalls: (turnId: typeof TURN) =>
			turnId === TURN ? control.reviewAllowedCalls : undefined,
		// The wiring `createAgentSession` gives the runtime.
		resolveAgentReview: (turnId, word) => {
			if (turnId !== TURN) return undefined
			const modeFor = (): PermissionMode =>
				delegatedAgentMode({ parent: control.current(), declared: word })
			return {
				resumeHandler: (request, ctx) => control.handlerForMode(modeFor())(request, ctx),
				reviewAllowedCalls: () => modeReviewsAllowedCalls(modeFor()),
			}
		},
	})
	try {
		await runtime.agentTool.execute(
			{
				description: 'touch two files',
				prompt: 'create first.txt then second.txt',
				subagent_type: 'worker',
			},
			context(),
		)
		return { cwd, asked, classifier }
	} finally {
		await runtime.close()
	}
}

describe('a child runs in its agent file’s mode when that narrows its parent', () => {
	it('is asked about its changes when the file names no mode', async () => {
		const { asked } = await childUnder(() => 'prompt', undefined)

		expect(asked).toEqual(['touch', 'touch'])
	})

	it('is refused every change when the file says plan and the parent asks', async () => {
		const { asked, cwd } = await childUnder(() => 'prompt', 'plan')

		expect(existsSync(join(cwd, 'first.txt'))).toBe(false)
		expect(asked).toEqual([])
	})

	it('keeps the parent’s bypass over a file that says plan', async () => {
		const { asked, cwd } = await childUnder(() => 'bypass', 'plan')

		expect(existsSync(join(cwd, 'second.txt'))).toBe(true)
		expect(asked).toEqual([])
	})

	it('does not grant bypass to a file under a parent that asks', async () => {
		const { asked } = await childUnder(() => 'prompt', 'bypass')

		expect(asked).toEqual(['touch', 'touch'])
	})
})
