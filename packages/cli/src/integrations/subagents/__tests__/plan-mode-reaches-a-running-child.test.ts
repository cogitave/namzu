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
	createReviewHandler,
	defineTool,
	mcpJsonSchemaToZod,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createLiveModeControl } from '../../../permissions/live-mode.js'
import type { PermissionMode } from '../../../permissions/mode.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * Plan mode entered while a sub-agent runs refuses that sub-agent's next
 * change, including one a permission rule allows.
 *
 * The child borrows its parent turn's live-mode handler, so a change that
 * reached the handler was already refused. One that did not reach it was not:
 * with `permissions: { touch: 'allow' }` the kernel ran the child's call
 * without asking, because the parent turn's `reviewAllowedCalls` (true in
 * plan mode) was handed to the parent's own `query()` and to no delegated
 * one. `resolveReviewAllowedCalls` hands it to the spawn context, and the
 * kernel stamps it on every descendant.
 */

const TURN = asTurnId('0d44c3f9-a5c4-44ae-a9de-8b9e3e920b32')
const workdirs: string[] = []

afterEach(() => {
	for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	vi.restoreAllMocks()
})

/** The operator's rule: `touch` runs without asking. */
const allowTouch: AuthorizationGateConfig = {
	enabled: true,
	rules: [{ type: 'allow_by_name', toolNames: ['touch'] }],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

function context(): ToolContext {
	return {
		sessionId: '5c1d7a3e-0b52-4c1f-9d8e-2a6f4b7c9e10',
		turnId: TURN,
		abortSignal: new AbortController().signal,
	} as ToolContext
}

async function scenario(options: { wireReviewAllowedCalls: boolean }) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-plan-'))
	workdirs.push(cwd)
	let mode: PermissionMode = 'prompt'
	const reviewed: string[][] = []
	// The parent turn's live mode, as `createAgentSession` builds it.
	const modeControl = createLiveModeControl({
		initial: 'prompt',
		read: () => mode,
		handlerFor: (m) =>
			createReviewHandler({
				mode: m,
				prompt: async () => ({ kind: 'approve' }),
				exempt: () => false,
			}),
	})
	const handler: ResumeHandler = async (request) => {
		if (request.type === 'tool_review') reviewed.push(request.toolCalls.map((tc) => tc.name))
		return modeControl.handler(request)
	}
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
					// The operator presses shift+tab into plan mode while the child
					// is running, right after its first change landed.
					mode = 'plan'
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
					{
						toolCalls: [{ id: 'c1', name: 'touch', args: { path: 'first.txt' } }],
					},
					{
						toolCalls: [{ id: 'c2', name: 'touch', args: { path: 'second.txt' } }],
					},
					{ text: 'child complete' },
				],
			}),
		buildTools: tools,
		authorizationGate: allowTouch,
		resolveResumeHandler: (turnId) => (turnId === TURN ? handler : undefined),
		...(options.wireReviewAllowedCalls
			? {
					resolveReviewAllowedCalls: (turnId: typeof TURN) =>
						turnId === TURN ? modeControl.reviewAllowedCalls : undefined,
				}
			: {}),
	})
	try {
		const result = await runtime.agentTool.execute(
			{
				description: 'touch two files',
				prompt: 'create first.txt then second.txt',
			},
			context(),
		)
		return { cwd, reviewed, result }
	} finally {
		await runtime.close()
	}
}

describe('plan mode entered while a sub-agent runs', () => {
	it("refuses the sub-agent's next rule-allowed change", async () => {
		const { cwd, reviewed, result } = await scenario({
			wireReviewAllowedCalls: true,
		})

		expect(existsSync(join(cwd, 'first.txt'))).toBe(true)
		expect(existsSync(join(cwd, 'second.txt'))).toBe(false)
		// The first call was allowed by the rule before plan mode and never
		// asked; the second reached the handler, which refused it in plan mode.
		expect(reviewed).toEqual([['touch']])
		expect(result.success).toBe(true)
	})

	it('without the parent switch, the rule let the change run past plan mode', async () => {
		// The defect, kept as the baseline that makes the test above mean
		// something: the child's handler knew about plan mode and was never asked.
		const { cwd, reviewed } = await scenario({ wireReviewAllowedCalls: false })

		expect(existsSync(join(cwd, 'second.txt'))).toBe(true)
		expect(reviewed).toEqual([])
	})
})
