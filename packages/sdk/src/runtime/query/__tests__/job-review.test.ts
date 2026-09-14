import { describe, expect, it, vi } from 'vitest'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { JobTool } from '../../../tools/builtins/job.js'
import type { AuthorizationRule } from '../../../types/authorization/index.js'
import type { PermissionMode } from '../../../types/permission/index.js'
import type { BackgroundJobRegistryRef, ToolContext } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { drainQuery } from '../index.js'
import { type ReviewMode, type ToolReviewRequest, createReviewHandler } from '../review-policy.js'

function registry() {
	const tools = new ToolRegistry()
	tools.register(JobTool)
	return tools
}

function context(permissionMode: PermissionMode): ToolContext {
	const runId = generateRunId()
	return {
		runId,
		workingDirectory: process.cwd(),
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		permissionContext: { mode: permissionMode, runId, workingDirectory: process.cwd() },
		backgroundJobs: {
			start: vi.fn(),
			get: vi.fn(),
			read: vi.fn(() => ({ chunk: 'ready', nextOffset: 5, droppedBytes: 0, status: 'running' })),
			list: vi.fn(() => [{ id: 'owned-job', status: 'running', command: 'owned command' }]),
			kill: vi.fn(async () => ({ id: 'owned-job', status: 'killed' })),
		} satisfies BackgroundJobRegistryRef,
	}
}

describe('background observation authority', () => {
	it.each(['read', 'list'] as const)(
		'allows %s in plan mode without granting stop authority',
		async (action) => {
			const ctx = context('plan')
			const tools = registry()
			const read = await tools.execute('job', { action, id: 'owned-job' }, ctx)
			expect(read.success).toBe(true)
			const stopped = await tools.execute('job', { action: 'kill', id: 'owned-job' }, ctx)
			expect(stopped.success).toBe(false)
			expect(ctx.backgroundJobs?.kill).not.toHaveBeenCalled()
		},
	)

	it.each([{}, null, { action: 'other' }])(
		'does not classify an unknown action as read-only',
		(input) => {
			expect(JobTool.isReadOnly?.(input as never)).toBe(false)
		},
	)
})

async function run(
	action: 'list' | 'kill',
	rules: AuthorizationRule[] = [],
	mode: ReviewMode = 'prompt',
) {
	const tools = registry()
	const prompt = vi.fn(async (_request: ToolReviewRequest) => ({
		kind: 'reject' as const,
		feedback: 'operator declined',
	}))
	const provider = new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'job-call', name: 'job', args: { action, id: 'unknown-job' } }] },
			{ text: 'finished' },
		],
	})
	const result = await drainQuery({
		provider,
		tools,
		agentId: 'job-review-fixture',
		agentName: 'Job review fixture',
		messages: [{ role: 'user', content: 'inspect the background work' }],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		runConfig: { model: 'mock', maxIterations: 3, tokenBudget: 10_000, timeoutMs: 5_000 },
		backgroundJobs: new BackgroundJobRegistry(),
		authorizationGate: {
			enabled: true,
			rules,
			allowReadOnlyTools: true,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		resumeHandler: createReviewHandler({ mode, prompt, registry: tools }),
	})
	return { result, prompt, provider }
}

describe('job review in the real query loop', () => {
	it('observes existing jobs without an extra approval', async () => {
		const { result, prompt, provider } = await run('list')
		expect(result.status).toBe('completed')
		expect(prompt).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests)).toContain('No background jobs.')
	})

	it('still asks before stopping work and respects rejection', async () => {
		const { prompt, provider } = await run('kill')
		expect(prompt).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(provider.requests)).toContain('operator declined')
	})

	it.each(['prompt', 'accept-edits'] as const)(
		'keeps explicit read review in %s mode',
		async (mode) => {
			const { prompt, provider } = await run(
				'list',
				[{ type: 'custom_pattern', pattern: '^job$', target: 'name', decision: 'review' }],
				mode,
			)
			expect(prompt).toHaveBeenCalledTimes(1)
			expect(prompt.mock.calls[0]?.[0]).toMatchObject({
				toolCalls: [{ authorization: { decision: 'review', explicitReview: true } }],
			})
			expect(JSON.stringify(provider.requests)).not.toContain('No background jobs.')
		},
	)

	it('does not override an explicit deny with observation authority', async () => {
		const { prompt, provider } = await run('list', [{ type: 'deny_by_name', toolNames: ['job'] }])
		expect(prompt).not.toHaveBeenCalled()
		expect(JSON.stringify(provider.requests)).toContain('Blocked by the authorization gate')
		expect(JSON.stringify(provider.requests)).not.toContain('No background jobs.')
	})
})
