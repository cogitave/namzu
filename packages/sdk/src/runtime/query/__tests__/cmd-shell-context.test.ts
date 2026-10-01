import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MockLLMProvider } from '../../../provider/mock.js'
import { testToolset } from '../../../test-support/toolset.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { setHostCommandShellForTesting } from '../../../tools/command-shell.js'
import type { HITLResumeDecision } from '../../../types/hitl/index.js'
import type { SandboxId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { PromptCache } from '../prompt-cache.js'

const directories: string[] = []
afterEach(async () => {
	setHostCommandShellForTesting(undefined)
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function base(provider: MockLLMProvider) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-cmd-query-'))
	directories.push(cwd)
	return {
		provider,
		toolsets: [testToolset(BashTool)],
		messages: [createUserMessage('inspect the shell')],
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_shell',
		agentName: 'Shell',
		workingDirectory: cwd,
		sessionId: '052b7785-2bcc-458a-8184-76dfbdbfdf58' as SessionId,
		topicId: '458174d9-b54f-43a9-9ccc-c3d87be14190' as TopicId,
		projectId: '8e2b818f-eb63-4f6e-a416-18b311dcb61c' as ProjectId,
		tenantId: '36da1973-021d-40d5-9a72-7ba4084729de' as TenantId,
	}
}
it('sends actual host CMD metadata and routes an otherwise-allowed command to exact-call review', async () => {
	setHostCommandShellForTesting({ path: undefined, dialect: 'cmd', source: 'platform' })
	const command = "echo 'safe & echo SECOND_COMMAND & echo '"
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'bash', args: { command } }] }, { text: 'refused' }],
	})
	const review = vi.fn(async () => ({ action: 'reject_tools' }) as HITLResumeDecision)
	const options = await base(provider)
	const execute = vi.fn(BashTool.execute)
	await drainQuery({
		...options,
		toolsets: [testToolset({ ...BashTool, execute })],
		resumeHandler: review,
		authorizationGate: {
			enabled: true,
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
			rules: [{ type: 'allow_by_name', toolNames: ['bash'] }],
		},
	})
	expect(review).toHaveBeenCalledTimes(1)
	expect(execute).not.toHaveBeenCalled()
	expect(JSON.stringify(provider.requests[0]?.messages)).toContain(
		'Execution shell for bash: cmd (host).',
	)
})
it('a cached query with a guest sandbox advertises sh despite a Windows CMD host', async () => {
	setHostCommandShellForTesting({ path: undefined, dialect: 'cmd', source: 'platform' })
	const provider = new MockLLMProvider({ responseText: 'guest shell' })
	const options = await base(provider)
	const guest: Sandbox = {
		id: '51281012-1dd1-444d-98b8-487422669dff' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: async () => {
			throw new Error('no command was requested')
		},
		writeFile: async () => {},
		readFile: async () => Buffer.alloc(0),
		listFiles: async () => [],
		destroy: async () => {},
	}
	await drainQuery({
		...options,
		promptCache: new PromptCache({ agentId: options.agentId, projectId: options.projectId }),
		sandboxProvider: {
			id: 'guest',
			name: 'Guest',
			environment: 'basic',
			create: async () => guest,
		},
	})
	const prompt = JSON.stringify(provider.requests[0]?.messages)
	expect(prompt).toContain('Execution shell for bash: sh (sandbox guest).')
	expect(prompt).not.toContain('Use native Windows CMD')
})
