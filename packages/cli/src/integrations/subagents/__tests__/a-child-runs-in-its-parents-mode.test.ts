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
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createLiveModeControl } from '../../../permissions/live-mode.js'
import type { PermissionMode } from '../../../permissions/mode.js'
import { type PermissionFn, makeResumeHandler } from '../../../tui/agent.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * A sub-agent follows its parent's mode unless its agent file names a
 * narrower one (`a-child-runs-in-its-agent-files-mode.test.ts`).
 *
 * Its calls are decided by the handler of the turn that started it, in that
 * turn's mode as it is when each call is made. So a child is in `bypass` only
 * when its parent is, an `accept-edits` or `auto` parent cannot be widened by
 * anything the child says about itself, and a parent that drops back to
 * `prompt` takes the child with it.
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
async function childUnder(mode: () => PermissionMode, onFirstCall?: () => void) {
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
		resolveResumeHandler: (turnId) => (turnId === TURN ? handler : undefined),
		resolveReviewAllowedCalls: (turnId: typeof TURN) =>
			turnId === TURN ? control.reviewAllowedCalls : undefined,
	})
	try {
		await runtime.agentTool.execute(
			{ description: 'touch two files', prompt: 'create first.txt then second.txt' },
			context(),
		)
		return { cwd, asked, classifier }
	} finally {
		await runtime.close()
	}
}

describe('a child is decided in its parent’s mode', () => {
	it('is asked about its changes when the parent asks', async () => {
		const { asked } = await childUnder(() => 'prompt')

		expect(asked).toEqual(['touch', 'touch'])
	})

	it('is not asked in bypass, because the parent is in bypass', async () => {
		const { asked, cwd } = await childUnder(() => 'bypass')

		expect(asked).toEqual([])
		expect(existsSync(join(cwd, 'second.txt'))).toBe(true)
	})

	it('puts the child’s calls to the parent’s classifier in auto', async () => {
		const { asked, classifier } = await childUnder(() => 'classify')

		expect(classifier.review).toHaveBeenCalledTimes(2)
		expect(asked).toEqual([])
	})

	it('follows the parent back to asking in the middle of the child’s run', async () => {
		let mode: PermissionMode = 'bypass'
		const { asked } = await childUnder(
			() => mode,
			() => {
				mode = 'prompt'
			},
		)

		// The first call ran under bypass; the second was asked once the parent
		// had dropped back.
		expect(asked).toEqual(['touch'])
	})

	it('is refused its second change when the parent moves into plan', async () => {
		let mode: PermissionMode = 'accept-edits'
		const { asked, cwd } = await childUnder(
			() => mode,
			() => {
				mode = 'plan'
			},
		)

		expect(existsSync(join(cwd, 'second.txt'))).toBe(false)
		// `accept-edits` approves edit and write only, so the first `touch` was
		// asked; the second was refused by plan without a question.
		expect(asked).toEqual(['touch'])
	})
})
