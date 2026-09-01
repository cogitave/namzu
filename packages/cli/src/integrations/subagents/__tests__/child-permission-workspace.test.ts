import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type AuthorizationGateConfig,
	LocalSandboxProvider,
	MockLLMProvider,
	NOOP_LOGGER,
	type ResumeHandler,
	type ToolContext,
	ToolRegistry,
	asRunId,
	getBuiltinTools,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { createSubagentRuntime } from '../runtime.js'

/**
 * Delegation must not turn interactive authorization into auto-approval.
 * The child is a separate run, but the human authority belongs to the parent
 * run that invoked Agent. It also works in the same caller-owned project tree.
 */

const workdirs: string[] = []

afterEach(() => {
	for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	vi.restoreAllMocks()
})

const reviewGate: AuthorizationGateConfig = {
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

function childTools(): ToolRegistry {
	const tools = new ToolRegistry()
	const write = getBuiltinTools().find((tool) => tool.name === 'write')
	if (!write) throw new Error('write tool fixture is missing')
	tools.register(write)
	return tools
}

function context(): ToolContext {
	return {
		runId: asRunId('run_parent_review'),
		abortSignal: new AbortController().signal,
	} as ToolContext
}

describe('a delegated write uses the parent run authority', () => {
	it.each([
		['rejects', { action: 'reject_tools', feedback: 'not approved' } as const, false],
		['approves', { action: 'approve_tools' } as const, true],
	])(
		'%s a real child write through the matching review channel',
		async (_label, decision, wrote) => {
			const cwd = mkdtempSync(join(tmpdir(), 'namzu-child-review-'))
			workdirs.push(cwd)
			const review = vi.fn<ResumeHandler>(async (request) =>
				request.type === 'tool_review' ? decision : { action: 'continue' },
			)
			const runtime = await createSubagentRuntime({
				cwd,
				model: 'mock-model',
				buildProvider: () =>
					new MockLLMProvider({
						turns: [
							{
								toolCalls: [
									{
										id: 'call_child_write',
										name: 'write',
										args: { path: 'child-marker.txt', content: 'written by child' },
									},
								],
							},
							{ text: 'child complete' },
						],
					}),
				buildTools: childTools,
				authorizationGate: reviewGate,
				resolveResumeHandler: (runId) =>
					runId === asRunId('run_parent_review') ? review : undefined,
				sandboxProvider: new LocalSandboxProvider(NOOP_LOGGER),
				sandboxWorkspace: 'working-directory',
			})

			try {
				const result = await runtime.agentTool.execute(
					{ description: 'write marker', prompt: 'write the marker file' },
					context(),
				)

				expect(result.success).toBe(true)
				const toolReviews = review.mock.calls
					.map(([request]) => request)
					.filter((request) => request.type === 'tool_review')
				expect(toolReviews).toHaveLength(1)
				expect(toolReviews[0]).toEqual(
					expect.objectContaining({
						type: 'tool_review',
						toolCalls: [expect.objectContaining({ name: 'write' })],
					}),
				)
				expect(existsSync(join(cwd, 'child-marker.txt'))).toBe(wrote)
				if (wrote)
					expect(readFileSync(join(cwd, 'child-marker.txt'), 'utf8')).toBe('written by child')
			} finally {
				await runtime.close()
			}
		},
	)
})
