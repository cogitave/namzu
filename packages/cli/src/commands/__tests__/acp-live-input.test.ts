import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	type Message,
	MockLLMProvider,
	SessionPaths,
	asTaskId,
	asTenantId,
	drainQuery,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { openSessionScope, openSessions } from '../../integrations/sessions/store.js'
import { subagentParentFixture } from '../../integrations/subagents/__fixtures__/parent.js'
import { createSubagentRuntime } from '../../integrations/subagents/runtime.js'
import { testToolset } from '../../test-support/toolset.js'
import type { AgentEvent, AgentSession, SendOptions } from '../../tui/agent.js'
import { withCliHarnesses } from '../acp-harness.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-live-input-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
function fixture(send: AgentSession['send'], overrides: Partial<AcpRuntimeDependencies> = {}) {
	const deps = {
		probe: async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: (value: unknown) => value,
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async () => ({
			hasProvider: true,
			errorHint: null,
			mcpFailed: [],
			send,
			close: async () => {},
			presenter: {
				presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
				presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
			},
			jobs: () => [],
		}),
		...overrides,
	} as unknown as AcpRuntimeDependencies
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		deps,
	)
	const run = (sessionId: string, signal = new AbortController().signal) =>
		runtime.gateway.prompt({
			sessionId,
			cwd,
			prompt: 'Start work',
			history: [],
			signal,
			onEvent() {},
			ask: async () => ({ kind: 'approve' }),
			filesystem: undefined,
		})
	return { runtime, run }
}

it('releases an actual delegated wait at a valid query boundary without aborting or relaunching its child', async () => {
	const parent = await subagentParentFixture(cwd)
	const started = deferred<AbortSignal>()
	const releaseChild = deferred<void>()
	const waiting = deferred<void>()
	const secondRequest = deferred<ChatCompletionParams>()
	const releaseParent = deferred<void>()
	let sendOptions: SendOptions | undefined
	let childCalls = 0
	const child = await createSubagentRuntime({
		cwd,
		model: 'mock',
		resolveParent: parent.resolveParent,
		resolveWaitForInbound: () => sendOptions?.waitForInbound,
		buildTools: () => [],
		buildProvider: () =>
			({
				id: 'held-child',
				name: 'Held child',
				async *chatStream(params) {
					childCalls++
					started.resolve(params.signal as AbortSignal)
					await releaseChild.promise
					yield* new MockLLMProvider({ responseText: 'Child finished' }).chatStream(params)
				},
			}) satisfies LLMProvider,
	})
	let taskId = ''
	const script = new MockLLMProvider({
		nextTurn: (_params, index) =>
			index === 0
				? {
						toolCalls: [
							{
								id: 'launch',
								name: 'Agent',
								args: {
									description: 'Held worker',
									prompt: 'Complete the held work',
									run_in_background: true,
								},
							},
						],
					}
				: index === 1
					? { toolCalls: [{ id: 'wait', name: 'wait_for_task', args: { task_id: taskId } }] }
					: { text: 'Your correction reached this turn.' },
	})
	let request = 0
	const provider: LLMProvider = {
		id: 'parent',
		name: 'Parent',
		async *chatStream(params) {
			const current = request++
			if (current === 1) {
				taskId = (await child.gatewayForTurn(parent.scope.turnId)).listTasks()[0]?.taskId ?? ''
			}
			if (current === 2) {
				secondRequest.resolve(params)
				await releaseParent.promise
			}
			yield* script.chatStream(params)
		},
	}
	const owner = fixture(async function* (messages, options) {
		sendOptions = options
		const wake = options?.waitForInbound
		if (!wake) throw new Error('Missing live wake channel')
		sendOptions = {
			...options,
			waitForInbound: (signal) => {
				const pending = wake(signal)
				waiting.resolve()
				return pending
			},
		}
		const result = await drainQuery({
			provider,
			toolsets: [testToolset(child.agentTool, child.waitForTaskTool)],
			taskScheduler: await child.gatewayForTurn(parent.scope.turnId),
			completionInbox: await child.completionInboxForTurn(parent.scope.turnId),
			...parent.scope,
			agentId: 'parent',
			agentName: 'Parent',
			workingDirectory: cwd,
			messages: [...messages],
			inboundMessages: options?.inboundMessages,
			waitForInbound: wake,
			signal: options?.signal,
			turnConfig: {
				model: 'mock',
				maxIterations: 3,
				tokenBudget: 1_000_000,
				permissionMode: 'auto',
				timeoutMs: 30_000,
			},
		})
		options?.onConversationMessages?.(result.messages)
		yield { kind: 'done', stopReason: result.stopReason }
	})
	const running = owner.run(parent.scope.sessionId)
	try {
		const childSignal = await started.promise
		await waiting.promise
		const status = await owner.runtime.liveInputStatus?.(parent.scope.sessionId)
		if (!status?.scopeId) throw new Error('No active scope')
		const input = {
			scopeId: status.scopeId,
			inputId: 'correction',
			prompt: 'Answer my question while the worker continues.',
		}
		expect(await owner.runtime.liveInput?.(parent.scope.sessionId, input)).toEqual({
			accepted: true,
			scopeId: status.scopeId,
			inputId: 'correction',
		})
		await owner.runtime.liveInput?.(parent.scope.sessionId, input)
		const next = await secondRequest.promise
		const delivered = next.messages.filter(
			(message) => message.role === 'user' && message.content === input.prompt,
		)
		expect(delivered).toHaveLength(1)
		const waitResult = next.messages.findIndex(
			(message) => message.role === 'tool' && message.toolCallId === 'wait',
		)
		const inputIndex = next.messages.indexOf(delivered[0] as Message)
		expect(waitResult).toBeGreaterThan(-1)
		expect(inputIndex).toBeGreaterThan(waitResult)
		expect(String(next.messages[waitResult]?.content)).toContain('has not completed')
		expect(childSignal.aborted).toBe(false)
		expect(childCalls).toBe(1)
		expect(
			await owner.runtime.liveInputStatus?.(parent.scope.sessionId, status.scopeId),
		).toMatchObject({ available: true, inputs: [{ id: 'correction', status: 'delivered' }] })
		releaseChild.resolve()
		await (await child.gatewayForTurn(parent.scope.turnId)).waitForTask(asTaskId(taskId))
		releaseParent.resolve()
		const completed = await running
		expect(
			(completed.history as Message[]).filter(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'runtime-context' &&
					message.source.kind === 'task-completion',
			),
		).toHaveLength(1)
	} finally {
		releaseChild.resolve()
		releaseParent.resolve()
		await running.catch(() => {})
		await child.close()
		await owner.runtime.close()
	}
})

it('keeps pending receipts after cancellation, drains once, and refuses idle, foreign, and stale scopes', async () => {
	const starts = [deferred<SendOptions>(), deferred<SendOptions>()]
	const releases = [deferred<void>(), deferred<void>()]
	let run = 0
	const owner = fixture(async function* (_messages, options) {
		const index = run++
		starts[index]?.resolve(options as SendOptions)
		await releases[index]?.promise
		yield { kind: 'done', stopReason: options?.signal?.aborted ? 'cancelled' : 'end_turn' }
	})
	const id = generateSessionId()
	const cancel = new AbortController()
	const first = owner.run(id, cancel.signal)
	try {
		const options = await starts[0]!.promise
		const status = await owner.runtime.liveInputStatus?.(id)
		if (!status?.scopeId) throw new Error('No active scope')
		const input = { scopeId: status.scopeId, inputId: 'first', prompt: 'Delivered text' }
		await owner.runtime.liveInput?.(id, input)
		expect(options.inboundMessages?.()).toMatchObject([{ role: 'user', content: 'Delivered text' }])
		expect(options.inboundMessages?.()).toEqual([])
		await owner.runtime.liveInput?.(id, {
			...input,
			inputId: 'pending',
			prompt: 'Preserve pending text',
		})
		await expect(
			owner.runtime.liveInput?.(id, { ...input, prompt: 'Changed payload' }),
		).rejects.toThrow('different message')
		await expect(owner.runtime.liveInput?.(generateSessionId(), input)).rejects.toThrow('no active')
		cancel.abort()
		expect(await owner.runtime.liveInputStatus?.(id, input.scopeId)).toMatchObject({
			available: false,
			inputs: [
				{ id: 'first', status: 'delivered' },
				{ id: 'pending', status: 'pending' },
			],
		})
		await expect(owner.runtime.liveInput?.(id, { ...input, inputId: 'too late' })).rejects.toThrow(
			'no longer available',
		)
		expect(options.inboundMessages?.()).toEqual([])
		releases[0]!.resolve()
		await first
		expect(await owner.runtime.liveInputStatus?.(id, input.scopeId)).toEqual({
			available: false,
			scopeId: input.scopeId,
			inputs: [
				{ id: 'first', status: 'delivered' },
				{ id: 'pending', status: 'pending' },
			],
		})
		await expect(owner.runtime.liveInput?.(id, input)).rejects.toThrow('no longer available')
		const second = owner.run(id)
		const next = await starts[1]!.promise
		expect(next.inboundMessages?.()).toEqual([])
		await expect(owner.runtime.liveInputStatus?.(id, input.scopeId)).rejects.toThrow('scope')
		await expect(owner.runtime.liveInput?.(id, input)).rejects.toThrow('no longer available')
		releases[1]!.resolve()
		await second
	} finally {
		for (const release of releases) release.resolve()
		await first.catch(() => {})
		await owner.runtime.close()
	}
})

it('bounds all accepted entries and characters, and removes cancelled wake listeners', async () => {
	const start = deferred<SendOptions>()
	const release = deferred<void>()
	const owner = fixture(async function* (_messages, options) {
		start.resolve(options as SendOptions)
		await release.promise
		yield { kind: 'done', stopReason: 'end_turn' }
	})
	const id = generateSessionId()
	const run = owner.run(id)
	try {
		const options = await start.promise
		const status = await owner.runtime.liveInputStatus?.(id)
		if (!status?.scopeId) throw new Error('No scope')
		const aborted = new AbortController()
		const remove = vi.spyOn(aborted.signal, 'removeEventListener')
		const failedWait = options.waitForInbound?.(aborted.signal)
		const rejection = expect(failedWait).rejects.toBe('cancel waiter')
		aborted.abort('cancel waiter')
		await rejection
		expect(remove).toHaveBeenCalledTimes(1)
		const wake = options.waitForInbound?.(new AbortController().signal)
		await expect(
			owner.runtime.liveInput?.(id, {
				scopeId: status.scopeId,
				inputId: 'oversize',
				prompt: 'x'.repeat(1_000_001),
			}),
		).rejects.toThrow('full')
		expect((await owner.runtime.liveInputStatus?.(id))?.inputs).toEqual([])
		for (let index = 0; index < 20; index++)
			await owner.runtime.liveInput?.(id, {
				scopeId: status.scopeId,
				inputId: String(index),
				prompt: 'x'.repeat(50_000),
			})
		await wake
		await expect(
			owner.runtime.liveInput?.(id, { scopeId: status.scopeId, inputId: 'extra', prompt: 'x' }),
		).rejects.toThrow('full')
		await owner.runtime.liveInput?.(id, {
			scopeId: status.scopeId,
			inputId: '0',
			prompt: 'x'.repeat(50_000),
		})
		expect((await owner.runtime.liveInputStatus?.(id))?.inputs).toHaveLength(20)
		expect(options.inboundMessages?.()).toHaveLength(20)
		await expect(
			owner.runtime.liveInput?.(id, {
				scopeId: status.scopeId,
				inputId: 'after drain',
				prompt: 'x',
			}),
		).rejects.toThrow('full')
	} finally {
		release.resolve()
		await run
		await owner.runtime.close()
	}
})

it('rejects a live record after application-home or trust replacement and rejects closed connections', async () => {
	const start = deferred<void>()
	const release = deferred<void>()
	let trusted = true
	const owner = fixture(
		async function* () {
			start.resolve()
			await release.promise
			yield { kind: 'done', stopReason: 'end_turn' }
		},
		{
			decideTrust: (({ cwd }: { cwd: string }) => ({
				allowed: trusted,
				cwd,
			})) as AcpRuntimeDependencies['decideTrust'],
		},
	)
	const id = generateSessionId()
	const run = owner.run(id)
	try {
		await start.promise
		const status = await owner.runtime.liveInputStatus?.(id)
		if (!status?.scopeId) throw new Error('No scope')
		const input = { scopeId: status.scopeId, inputId: 'first', prompt: 'Exact owner' }
		trusted = false
		await expect(owner.runtime.liveInput?.(id, input)).rejects.toThrow('trusted project')
		trusted = true
		mkdirSync(join(root, 'replacement'))
		vi.stubEnv('NAMZU_HOME', join(root, 'replacement'))
		await expect(owner.runtime.liveInputStatus?.(id)).rejects.toThrow('application home')
		vi.stubEnv('NAMZU_HOME', join(root, 'state'))
		release.resolve()
		await run
		await owner.runtime.close()
		await expect(owner.runtime.liveInputStatus?.(id)).rejects.toThrow('closed')
		await expect(owner.runtime.liveInput?.(id, input)).rejects.toThrow('no active')
	} finally {
		release.resolve()
		await run.catch(() => {})
		await owner.runtime.close()
	}
})

it.each<Extract<AgentEvent, { kind: 'done' | 'error' | 'paused' }>>([
	{ kind: 'done', stopReason: 'end_turn' },
	{ kind: 'error', message: 'Fixture failure' },
	{
		kind: 'paused',
		turnId: 'fixture-turn',
		checkpointId: 'fixture-checkpoint',
		reason: 'Fixture pause',
	},
])(
	'closes a $kind mailbox before generator cleanup while retaining pending receipts',
	async (terminal) => {
		const start = deferred<SendOptions>()
		const publishTerminal = deferred<void>()
		const cleaningUp = deferred<void>()
		const releaseCleanup = deferred<void>()
		const owner = fixture(async function* (_messages, options) {
			start.resolve(options ?? {})
			await publishTerminal.promise
			yield terminal
			cleaningUp.resolve()
			await releaseCleanup.promise
		})
		const id = generateSessionId()
		const run = owner.run(id).catch((error: unknown) => error)
		try {
			const options = await start.promise
			const status = await owner.runtime.liveInputStatus?.(id)
			if (!status?.scopeId) throw new Error('No scope')
			const input = {
				scopeId: status.scopeId,
				inputId: 'pending',
				prompt: 'Retain this authored text',
			}
			await owner.runtime.liveInput?.(id, input)
			publishTerminal.resolve()
			await cleaningUp.promise
			expect(await owner.runtime.liveInputStatus?.(id, status.scopeId)).toEqual({
				available: false,
				scopeId: status.scopeId,
				inputs: [{ id: input.inputId, status: 'pending' }],
			})
			await expect(owner.runtime.liveInput?.(id, input)).rejects.toThrow('no longer available')
			expect(options.inboundMessages?.()).toEqual([])
		} finally {
			publishTerminal.resolve()
			releaseCleanup.resolve()
			await run
			await owner.runtime.close()
		}
	},
)

it('binds host handoff to the actual admitted tenant and journal layout before admitting text', async () => {
	const admitted = await openSessions(cwd, { stateRoot: join(root, 'state'), indexBackend: 'scan' })
	const fresh = await openSessionScope(cwd, { stateRoot: admitted.root })
	const start = deferred<SendOptions>()
	const release = deferred<void>()
	const owner = fixture(
		async function* (_messages, options) {
			start.resolve(options ?? {})
			await release.promise
			yield { kind: 'done', stopReason: 'end_turn' }
		},
		{ openSessions: async () => admitted },
	)
	const id = generateSessionId()
	const run = owner.run(id)
	try {
		const options = await start.promise
		const status = await owner.runtime.liveInputStatus?.(id, undefined, fresh)
		if (!status?.scopeId) throw new Error('No scope')
		const input = { scopeId: status.scopeId, inputId: 'owned-input', prompt: 'Admitted owner only' }
		for (const wrong of [
			{ ...fresh, tenantId: asTenantId(generateSessionId()) },
			{ ...fresh, projectRoot: join(root, 'foreign-project') },
			{ ...fresh, paths: new SessionPaths({ home: fresh.paths.home, slug: 'foreign-project' }) },
		]) {
			await expect(owner.runtime.liveInput?.(id, input, wrong)).rejects.toThrow(
				'admitted session scope',
			)
			await expect(owner.runtime.liveInputStatus?.(id, status.scopeId, wrong)).rejects.toThrow(
				'admitted session scope',
			)
		}
		expect((await owner.runtime.liveInputStatus?.(id, status.scopeId, fresh))?.inputs).toEqual([])
		await owner.runtime.liveInput?.(id, input, fresh)
		expect(options.inboundMessages?.().map((message) => message.content)).toEqual([input.prompt])
	} finally {
		release.resolve()
		await run.catch(() => {})
		await owner.runtime.close()
	}
})

it('never forwards native-engine live input to a base Namzu route', async () => {
	const owner = fixture(async function* () {
		yield { kind: 'done', stopReason: 'end_turn' }
	})
	const status = vi
		.spyOn(owner.runtime, 'liveInputStatus')
		.mockResolvedValue({ available: true, scopeId: 'base-scope', inputs: [] })
	const input = vi
		.spyOn(owner.runtime, 'liveInput')
		.mockResolvedValue({ accepted: true, scopeId: 'base-scope', inputId: 'input' })
	const wrapped = withCliHarnesses(owner.runtime, cwd, {
		decideTrust: (({ cwd }: { cwd: string }) => ({
			allowed: true,
			cwd,
		})) as AcpRuntimeDependencies['decideTrust'],
		isPal: () => false,
		installed: async () => true,
		models: async () => [{ id: 'mock-native', label: 'Mock native' }],
		adapter: async () => {
			throw new Error('Native adapter must not run')
		},
	})
	try {
		const id = generateSessionId()
		await wrapped.selectHarness(id, 'codex-cli')
		expect(await wrapped.liveInputStatus?.(id)).toEqual({ available: false, inputs: [] })
		await expect(
			wrapped.liveInput?.(id, { scopeId: 'base-scope', inputId: 'input', prompt: 'Correction' }),
		).rejects.toThrow('unavailable')
		expect(status).not.toHaveBeenCalled()
		expect(input).not.toHaveBeenCalled()
	} finally {
		await wrapped.close()
	}
})
