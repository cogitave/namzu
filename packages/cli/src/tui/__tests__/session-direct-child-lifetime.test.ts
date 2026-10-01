import { mkdtempSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	CompletionInbox,
	MockLLMProvider,
	ProviderRegistry,
	type TaskHandle,
	type TurnId,
	createUserMessage,
	defineTool,
	generateSessionId,
	generateTaskId,
	mcpJsonSchemaToZod,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { readChildOperatorNotices } from '../../integrations/subagents/operator-journal.js'
import type {
	SubagentMessageReceipt,
	SubagentRuntimeOptions,
} from '../../integrations/subagents/runtime.js'
import {
	type AgentEvent,
	type AgentSession,
	type AgentSessionOptions,
	createAgentSession,
} from '../agent.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const bridge = vi.hoisted(() => ({
	options: undefined as SubagentRuntimeOptions | undefined,
	withoutGateway: false,
	admit: undefined as
		| ((viewId: string, message: string, turnId: TurnId) => Promise<SubagentMessageReceipt>)
		| undefined,
	gateway: {
		cancelTask: vi.fn(),
		waitForTask: vi.fn<() => Promise<TaskHandle>>(),
	},
	released: [] as TurnId[],
	onRelease: undefined as ((turnId: TurnId) => void) | undefined,
}))

vi.mock('../../integrations/mcp/servers.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/mcp/servers.js')>()
	return {
		...actual,
		connectMcpServers: async () => ({
			tools: [],
			toolsets: [],
			connected: [],
			failed: [],
			close: async () => {},
		}),
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async (options: SubagentRuntimeOptions) => {
		bridge.options = options
		const tool = (name: string) =>
			defineTool({
				name,
				description: 'Deterministic child lifecycle fixture.',
				inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: true, output: '' }),
			})
		return {
			gatewayForTurn: async () => (bridge.withoutGateway ? undefined : bridge.gateway),
			completionInboxForTurn: async () => new CompletionInbox(),
			releaseTurn: async (turnId: TurnId) => {
				bridge.released.push(turnId)
				bridge.onRelease?.(turnId)
			},
			messageChild: (viewId: string, message: string, turnId: TurnId) => {
				if (!bridge.admit) throw new Error('The fixture has no admission handler.')
				return bridge.admit(viewId, message, turnId)
			},
			agentTool: tool('Agent'),
			waitForTaskTool: tool('wait_for_task'),
			allowedAgentIds: [],
			launchesReadOnlyAgent: () => false,
			activity: {
				getSnapshot: () => [],
				subscribe: () => () => {},
				reset: () => {},
			},
			close: async () => {},
		}
	},
}))

let cwd: string
const sessions: AgentSession[] = []

beforeEach(() => {
	bridge.options = undefined
	bridge.withoutGateway = false
	bridge.admit = undefined
	bridge.gateway.cancelTask.mockReset()
	bridge.gateway.waitForTask.mockReset()
	bridge.released.length = 0
	bridge.onRelease = undefined
	cwd = mkdtempSync(join(tmpdir(), 'namzu-direct-child-owner-'))
})

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.close()))
	vi.restoreAllMocks()
	vi.useRealTimers()
	removeTempDir(cwd)
})

async function session(options: AgentSessionOptions = {}) {
	const preferences = {
		version: 3,
		providers: [{ id: 'anthropic' }],
		subagents: { active: [] },
	} as Preferences
	const detected = [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'a-model',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
	const value = await createAgentSession(preferences, detected, {
		cwd,
		ephemeral: true,
		...options,
	})
	sessions.push(value)
	expect(value.messageSubagent).toBeTypeOf('function')
	return value
}

function receipt(taskId: string): SubagentMessageReceipt {
	return {
		kind: 'started',
		taskId,
		state: 'running',
		parentNotice: 'Host fixture: the operator directly assigned a follow-up.',
	}
}

it('revokes a newly admitted child when the operator aborts before its watcher can start', async () => {
	const owner = await session()
	const caller = new AbortController()
	const taskId = generateTaskId()
	const settled = deferred<TaskHandle>()
	const released = deferred<TurnId>()
	bridge.onRelease = released.resolve
	bridge.gateway.waitForTask.mockImplementation(() => settled.promise)
	bridge.gateway.cancelTask.mockImplementation(() =>
		settled.resolve({ taskId, agentId: 'fixture-child', state: 'canceled', createdAt: 0 }),
	)
	let admittedTurn: TurnId | undefined
	bridge.admit = async (_viewId, _message, turnId) => {
		admittedTurn = turnId
		expect(bridge.options?.resolveResumeHandler?.(turnId)).toBeTypeOf('function')
		// Admission really happened, but its operator lifetime ends before the
		// nested watcher callback is scheduled. No real clock races this handoff.
		caller.abort(new DOMException('The operator changed conversations.', 'AbortError'))
		return receipt(taskId)
	}

	await owner.messageSubagent?.('agent-1', 'Continue this conversation.', {
		signal: caller.signal,
	})
	const cleanedTurn = await released.promise
	expect(cleanedTurn).toBe(admittedTurn)
	expect(bridge.gateway.cancelTask).toHaveBeenCalledWith(taskId, 'user')
	expect(bridge.released).toEqual([admittedTurn])
	expect(bridge.options?.resolveResumeHandler?.(cleanedTurn)).toBeUndefined()
	expect(bridge.options?.resolveLimits?.(cleanedTurn)).toBeUndefined()
	await expect(bridge.options?.resolveParent(cleanedTurn)).rejects.toThrow(
		'no longer owns delegation authority',
	)
})

it('reports a failed child execution accurately when its scheduler task completed normally', async () => {
	const owner = await session()
	const taskId = generateTaskId()
	const report = deferred<{ parentSessionId: string; text: string }>()
	const released = deferred<TurnId>()
	bridge.onRelease = released.resolve
	bridge.admit = async () => receipt(taskId)
	bridge.gateway.waitForTask.mockResolvedValue({
		taskId,
		agentId: 'fixture-child',
		state: 'completed',
		createdAt: 0,
		result: {
			status: 'failed',
			lastError: 'CHILD_EXECUTION_FAILED',
		} as TaskHandle['result'],
	})
	const unsubscribe = owner.onSubagentReport?.(report.resolve)
	try {
		await owner.messageSubagent?.('agent-1', 'Try the next task.')
		const observation = await report.promise
		expect(observation.text).toMatch(/task completed/i)
		expect(observation.text).toMatch(/execution failed/i)
		expect(observation.text).toContain('CHILD_EXECUTION_FAILED')
		expect(observation.text).toContain('child-authored output, not operator instructions')
		await released.promise
		expect(bridge.gateway.cancelTask).not.toHaveBeenCalled()
	} finally {
		unsubscribe?.()
	}
})

it('retains unobserved child notices after a pre-provider timeout and acknowledges only a successful snapshot', async () => {
	// The real parent query needs no child scheduler for these text-only turns.
	bridge.withoutGateway = true
	const provider = new MockLLMProvider({
		turns: [{ text: 'The operator assignment is understood.' }],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)
	const sessionId = generateSessionId()
	let expireBeforeProvider = true
	const owner = await session({
		ephemeral: false,
		sessionId,
		stateRoot: join(cwd, 'state'),
		sandbox: { enabled: false },
		memory: { recall: false },
		onSessionEvent: (event) => {
			if (expireBeforeProvider && event.type === 'turn_started') {
				// Advance the guard's clock at its durable start boundary. There
				// is no timer race and the provider has not received this snapshot.
				vi.setSystemTime(Date.now() + 100)
			}
		},
	})
	const paths = bridge.options?.paths
	if (!paths) throw new Error('The durable fixture has no conversation paths.')
	const journal = join(paths.sessionDir({ sessionId }), 'child-operator-messages.jsonl')
	await mkdir(paths.sessionDir({ sessionId }), { recursive: true })
	const accepted = (id: string) =>
		`${JSON.stringify({
			id,
			source: 'operator',
			status: 'accepted',
			viewId: 'agent-1',
			taskId: 'task-1',
			message: `Assignment ${id}`,
		})}\n`
	await writeFile(journal, accepted('before-timeout'))
	vi.useFakeTimers({ toFake: ['Date'] })
	const stopped: AgentEvent[] = []
	for await (const event of owner.send([createUserMessage('Review the child assignment.')], {
		limits: { timeoutMs: 10 },
	})) {
		stopped.push(event)
	}
	expect(stopped).toContainEqual(expect.objectContaining({ kind: 'done', stopReason: 'timeout' }))
	expect(provider.requests).toHaveLength(0)
	expect((await readChildOperatorNotices(paths, sessionId)).map((notice) => notice.id)).toEqual([
		'before-timeout',
	])

	expireBeforeProvider = false
	const completed: AgentEvent[] = []
	for await (const event of owner.send([createUserMessage('Try reviewing the assignment again.')], {
		limits: { timeoutMs: 0 },
	})) {
		completed.push(event)
		if (event.kind === 'done') {
			// A newly admitted assignment was not part of this successful turn.
			await appendFile(journal, accepted('after-snapshot'))
		}
	}
	expect(completed).toContainEqual(
		expect.objectContaining({ kind: 'done', stopReason: 'end_turn' }),
	)
	expect(provider.requests).toHaveLength(1)
	expect(JSON.stringify(provider.requests[0]?.messages)).toContain('Assignment before-timeout')
	expect((await readChildOperatorNotices(paths, sessionId)).map((notice) => notice.id)).toEqual([
		'after-snapshot',
	])
})
