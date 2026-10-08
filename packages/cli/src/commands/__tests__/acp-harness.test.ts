import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type HarnessAdapter,
	type HarnessEventSink,
	type HarnessModel,
	type HarnessNativeTurn,
	type HarnessPrompt,
	generateSessionId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import {
	archiveConversation,
	closeSessions,
	openConversationLog,
	openSessions,
	readConversationFacts,
} from '../../integrations/sessions/store.js'
import { type CliHarnessRuntime, withCliHarnesses } from '../acp-harness.js'
import type { CliAcpRuntime } from '../acp.js'

const directories: string[] = []
const runtimes: CliHarnessRuntime[] = []
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()))
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function fixture(engine: 'codex-cli' | 'claude-code' = 'codex-cli') {
	const root = await mkdtemp(join(tmpdir(), 'namzu-harness-acp-'))
	directories.push(root)
	const sessionId = generateSessionId()
	const base: CliAcpRuntime = {
		gateway: {
			prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
			load: vi.fn(async () => []),
		},
		providerStatus: vi.fn(async () => ({ available: [], selected: null })),
		models: vi.fn(async () => ({ models: [], notice: null })),
		modelSettings: vi.fn(async () => ({})),
		selectProvider: vi.fn(async () => {}),
		plugins: vi.fn(async () => ({
			plugins: [],
			canChange: false,
			live: false,
		})),
		setPluginEnabled: vi.fn(async () => ({
			plugins: [],
			canChange: false,
			live: false,
		})),
		jobs: () => [],
		readJob: () => null,
		stopJob: async () => null,
		presenter: {
			presentCall: () => ({ kind: 'generic', label: '' }),
			presentResult: () => ({ kind: 'generic', label: '' }),
		},
		close: vi.fn(async () => {}),
	}
	let reviewed = false
	let emit!: HarnessEventSink
	let native!: HarnessNativeTurn
	let turns = 0
	const close = vi.fn(async () => ({ stopped: true as const }))
	const dispatches: HarnessPrompt[] = []
	const terminal = async () => {
		const nativeItemId = `answer-${turns}`
		await emit({ kind: 'message-started', ...native, nativeItemId })
		await emit({
			kind: 'message-completed',
			...native,
			nativeItemId,
			content: 'Native engine answer',
			stopReason: 'end_turn',
		})
		await emit({
			kind: 'turn-completed',
			...native,
			status: 'completed',
			finalItemId: nativeItemId,
			result: 'Native engine answer',
		})
	}
	const adapter: HarnessAdapter = {
		engineId: engine === 'codex-cli' ? 'codex' : 'claude',
		profileRef: 'host-owned-fixture-route',
		open: vi.fn<HarnessAdapter['open']>(async ({ cwd, model, resume }, onEvent) => {
			emit = onEvent
			const binding = resume ?? {
				v: 1 as const,
				engineId: adapter.engineId,
				profileRef: adapter.profileRef,
				nativeSessionId: 'opaque-native-thread',
				cwd,
				initialModel: model as string,
			}
			return {
				binding,
				capabilities: {
					persistentSessions: true,
					history: 'snapshot',
					models: 'discover',
					permissions: 'interactive',
					interrupt: 'native-terminal',
					attachments: [],
					reviewModes:
						engine === 'codex-cli'
							? ['prompt', 'plan', 'accept-edits', 'auto', 'strict']
							: ['prompt', 'plan'],
				},
				models: async () => [
					{ id: 'actual-model', label: 'Actual model' },
					{ id: 'other-model', label: 'Other model' },
				],
				dispatch: async (request) => {
					dispatches.push(request)
					native = {
						nativeSessionId: binding.nativeSessionId,
						nativeTurnId: `turn-${++turns}`,
					}
					await emit({ kind: 'turn-started', ...native })
					if (reviewed)
						await emit({
							kind: 'review-requested',
							request: {
								...native,
								requestId: `review-${turns}`,
								kind: 'command',
								title: 'Proposed command',
								input: { command: 'example' },
								decisions: ['approve-once', 'reject'],
							},
						})
					else await terminal()
					return native
				},
				interrupt: async () => {
					await emit({
						kind: 'turn-completed',
						...native,
						status: 'cancelled',
					})
					return { requested: true }
				},
				respond: async () => {
					await terminal()
					return { sent: true }
				},
				readHistory: async () => ({
					binding,
					events: [],
					pendingReviews: [],
					complete: true,
				}),
				close,
			}
		}),
	}
	const dependencies = {
		adapter: vi.fn(async () => adapter),
		models: vi.fn(async () => [
			{ id: 'actual-model', label: 'Actual model' },
			{ id: 'other-model', label: 'Other model' },
		]),
		installed: vi.fn(async () => true),
		openSessions: (cwd: string) =>
			openSessions(cwd, {
				stateRoot: join(root, 'state'),
				indexBackend: 'scan',
			}),
		decideTrust: ({ cwd }: { cwd: string }) => ({
			allowed: true as const,
			cwd,
		}),
		isPal: () => false,
	}
	const runtime = withCliHarnesses(base, root, dependencies)
	runtimes.push(runtime)
	const archiveIdle = runtime.withIdleConversationForArchive
	expect(archiveIdle).toBeTypeOf('function')
	if (!archiveIdle) throw new Error('The native runtime must provide its idle archive reservation.')
	const prompt = (
		text = 'First external prompt',
		ask: Parameters<CliAcpRuntime['gateway']['prompt']>[0]['ask'] = vi.fn(async () => ({
			kind: 'approve' as const,
		})),
		options?: Parameters<CliAcpRuntime['gateway']['prompt']>[0]['options'],
	) =>
		runtime.gateway.prompt({
			sessionId,
			cwd: root,
			prompt: text,
			filesystem: undefined,
			history: [],
			signal: new AbortController().signal,
			onEvent: vi.fn(),
			ask,
			...(options ? { options } : {}),
		})
	return {
		root,
		runtime,
		archiveIdle,
		dependencies,
		adapter,
		close,
		base,
		sessionId,
		prompt,
		dispatches,
		review: () => {
			reviewed = true
		},
	}
}

it('releases its idle native writer while reserving the conversation until strict archive settles', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	await f.prompt()
	const state = await f.dependencies.openSessions(f.root)
	const log = openConversationLog(state, f.sessionId)
	const entered = deferred<void>()
	const allowed = deferred<void>()
	try {
		expect(await log.claim({ holder: 'competing-fixture', ttlMs: 30_000 })).toBeNull()
		const archiving = f.archiveIdle(f.sessionId, state, async () => {
			entered.resolve()
			await allowed.promise
			await archiveConversation(state, f.sessionId)
			return { archived: true }
		})
		await entered.promise
		expect(f.close).toHaveBeenCalledOnce()
		expect(f.base.close).not.toHaveBeenCalled()
		await expect(f.prompt('Cannot start before archive acknowledgement')).rejects.toThrow(
			'already connecting',
		)
		await expect(f.runtime.selectProvider(f.sessionId, 'codex-cli', 'other-model')).rejects.toThrow(
			'before changing its model',
		)
		expect(f.dispatches).toHaveLength(1)
		allowed.resolve()
		expect(await archiving).toEqual({ archived: true })
		expect((await readConversationFacts(state, f.sessionId))?.archived).toBe(true)
		await expect(f.runtime.gateway.load?.(f.sessionId, f.root)).rejects.toThrow('archived')
	} finally {
		allowed.resolve()
		closeSessions(state)
	}
})

it('refuses a waiting native review before closing its connection or invoking archive', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	f.review()
	const asked = deferred<void>()
	const decision = deferred<{ kind: 'approve' }>()
	const prompt = f.prompt('Wait for review', async () => {
		asked.resolve()
		return decision.promise
	})
	await asked.promise
	const state = await f.dependencies.openSessions(f.root)
	const archive = vi.fn(async () => {})
	try {
		await expect(f.archiveIdle(f.sessionId, state, archive)).rejects.toThrow('pending operation')
		expect(f.close).not.toHaveBeenCalled()
		expect(archive).not.toHaveBeenCalled()
		expect((await readConversationFacts(state, f.sessionId))?.activeTurn).toBeDefined()
	} finally {
		decision.resolve({ kind: 'approve' })
		await prompt
		closeSessions(state)
	}
})

it('retains the native cleanup owner and writer after close fails so archive can be retried', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	await f.prompt()
	const state = await f.dependencies.openSessions(f.root)
	const archive = vi.fn(async () => {
		await archiveConversation(state, f.sessionId)
	})
	f.close.mockRejectedValueOnce(new Error('native cleanup not confirmed'))
	try {
		await expect(f.archiveIdle(f.sessionId, state, archive)).rejects.toThrow(
			'native cleanup not confirmed',
		)
		expect(archive).not.toHaveBeenCalled()
		expect((await readConversationFacts(state, f.sessionId))?.archived).toBe(false)
		expect(
			await openConversationLog(state, f.sessionId).claim({
				holder: 'competing-fixture',
				ttlMs: 30_000,
			}),
		).toBeNull()
		await f.archiveIdle(f.sessionId, state, archive)
		expect(f.close).toHaveBeenCalledTimes(2)
		expect(archive).toHaveBeenCalledOnce()
		expect((await readConversationFacts(state, f.sessionId))?.archived).toBe(true)
	} finally {
		closeSessions(state)
	}
})

it('refuses a different captured archive home before touching its native owner', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	await f.prompt()
	const state = await f.dependencies.openSessions(f.root)
	const archive = vi.fn(async () => {})
	try {
		await expect(
			f.archiveIdle(f.sessionId, { ...state, root: join(f.root, 'different-state') }, archive),
		).rejects.toThrow('archive scope')
		expect(f.close).not.toHaveBeenCalled()
		expect(archive).not.toHaveBeenCalled()
	} finally {
		closeSessions(state)
	}
})

it('uses a separate native catalogue and durable engine without constructing a Namzu provider', async () => {
	const f = await fixture()
	expect((await f.runtime.harnesses(f.sessionId)).selected).toBe('namzu')
	expect(f.adapter.open).not.toHaveBeenCalled()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	expect(await f.runtime.providerStatus(f.sessionId)).toMatchObject({
		selected: { id: 'codex-cli', model: 'actual-model' },
	})
	expect(f.adapter.open).not.toHaveBeenCalled()
	await expect(f.prompt()).resolves.toMatchObject({ stopReason: 'end_turn' })
	expect(f.base.gateway.prompt).not.toHaveBeenCalled()
	expect(f.base.selectProvider).not.toHaveBeenCalled()
	const state = await f.dependencies.openSessions(f.root)
	try {
		expect((await readConversationFacts(state, f.sessionId))?.started.harness).toMatchObject({
			engineId: 'codex',
			nativeSessionId: 'opaque-native-thread',
			cwd: f.root,
		})
	} finally {
		closeSessions(state)
	}
	await expect(f.runtime.selectHarness(f.sessionId, 'namzu')).rejects.toThrow('keeps its engine')
})

it('uses the current turn asker for successive native approval requests', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	f.review()
	const first = vi.fn(async () => ({ kind: 'approve' as const }))
	const second = vi.fn(async () => ({
		kind: 'reject' as const,
		feedback: 'Declined',
	}))
	await f.prompt('First', first)
	await f.prompt('Second', second)
	expect(first).toHaveBeenCalledTimes(1)
	expect(second).toHaveBeenCalledTimes(1)
})

it('rejects fabricated engine models, Namzu provider aliases and unsupported settings before native dispatch', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	await expect(f.runtime.selectProvider(f.sessionId, 'zen', 'space-bunny-free')).rejects.toThrow(
		'own engine model catalogue',
	)
	await expect(f.runtime.selectProvider(f.sessionId, 'codex-cli', 'invented')).rejects.toThrow(
		'listed by this engine',
	)
	await expect(
		f.runtime.gateway.prompt({
			sessionId: f.sessionId,
			cwd: f.root,
			prompt: 'No send',
			filesystem: undefined,
			history: [],
			options: { permissionMode: 'unsupported' as never },
			signal: new AbortController().signal,
			onEvent: () => {},
			ask: async () => ({ kind: 'approve' }),
		}),
	).rejects.toThrow('does not support the selected permission mode')
	expect(f.adapter.open).not.toHaveBeenCalled()
})

it.each(['prompt', 'plan', 'accept-edits', 'auto', 'strict'] as const)(
	'admits the actual Codex %s mode without changing it or invoking the kernel',
	async (permissionMode) => {
		const f = await fixture()
		await f.runtime.selectHarness(f.sessionId, 'codex-cli')
		await expect(f.prompt('Explicit mode', undefined, { permissionMode })).resolves.toMatchObject({
			stopReason: 'end_turn',
		})
		expect(f.dispatches).toHaveLength(1)
		expect(f.dispatches[0]?.permissionMode).toBe(permissionMode)
		expect(f.base.gateway.prompt).not.toHaveBeenCalled()
	},
)

it.each(['accept-edits', 'auto', 'strict'] as const)(
	'refuses unsupported Claude %s mode before native process startup',
	async (permissionMode) => {
		const f = await fixture('claude-code')
		await f.runtime.selectHarness(f.sessionId, 'claude-code')
		await expect(f.prompt('No send', undefined, { permissionMode })).rejects.toThrow(
			'Ask first and Plan',
		)
		expect(f.adapter.open).not.toHaveBeenCalled()
		expect(f.dispatches).toEqual([])
		expect(f.base.gateway.prompt).not.toHaveBeenCalled()
	},
)

it('preserves normal conversations on their original kernel path', async () => {
	const f = await fixture()
	await f.prompt()
	expect(f.base.gateway.prompt).toHaveBeenCalledOnce()
	expect(f.adapter.open).not.toHaveBeenCalled()
})

it('reads a completed native conversation after reconnect without starting its engine', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	await f.prompt()
	await f.runtime.close()
	const next = withCliHarnesses(f.base, f.root, f.dependencies)
	runtimes.push(next)
	expect(await next.gateway.load?.(f.sessionId, f.root)).toHaveLength(2)
	expect((await next.harnesses(f.sessionId)).selected).toBe('codex-cli')
	expect(f.adapter.open).toHaveBeenCalledOnce()
	await expect(next.selectHarness(f.sessionId, 'claude-code')).rejects.toThrow('keeps its engine')
})

it('refuses untrusted folders and Pal workspaces before metadata or adapter access', async () => {
	const f = await fixture()
	const denied = withCliHarnesses(f.base, f.root, {
		...f.dependencies,
		decideTrust: () => ({
			allowed: false,
			cwd: f.root,
			message: 'Not trusted',
		}),
	})
	runtimes.push(denied)
	await expect(denied.selectHarness(f.sessionId, 'codex-cli')).rejects.toThrow('Not trusted')
	const pal = withCliHarnesses(f.base, f.root, {
		...f.dependencies,
		isPal: () => true,
	})
	runtimes.push(pal)
	await expect(pal.selectHarness(f.sessionId, 'codex-cli')).rejects.toThrow(
		'normal conversations only',
	)
	expect(f.dependencies.models).not.toHaveBeenCalled()
	expect(f.dependencies.adapter).not.toHaveBeenCalled()
})

it('reserves an engine selection before awaited metadata and rejects overlapping sends or selectors', async () => {
	const f = await fixture()
	const metadata = deferred<readonly HarnessModel[]>()
	const entered = deferred<void>()
	f.dependencies.models.mockImplementationOnce(async () => {
		entered.resolve()
		return [...(await metadata.promise)]
	})
	const selecting = f.runtime.selectHarness(f.sessionId, 'codex-cli')
	await entered.promise
	await expect(f.prompt()).rejects.toThrow('already connecting')
	await expect(f.runtime.selectHarness(f.sessionId, 'claude-code')).rejects.toThrow(
		'before changing its engine',
	)
	await expect(f.runtime.selectProvider(f.sessionId, 'zen', 'foreign')).rejects.toThrow(
		'before changing its model',
	)
	expect(f.base.gateway.prompt).not.toHaveBeenCalled()
	expect(f.dependencies.adapter).not.toHaveBeenCalled()
	metadata.resolve([{ id: 'actual-model', label: 'Actual model' }])
	expect((await selecting).selected).toBe('codex-cli')
	await expect(f.prompt()).resolves.toMatchObject({ stopReason: 'end_turn' })
	expect(f.dependencies.adapter).toHaveBeenCalledWith('codex-cli')
})

it('passes the engine default flag through the models handler and omits it elsewhere', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	f.dependencies.models.mockImplementationOnce(async () => [
		{ id: 'actual-model', label: 'Actual model', default: true } as HarnessModel,
		{ id: 'other-model', label: 'Other model' },
	])
	const view = await f.runtime.models('codex-cli', f.sessionId)
	expect(view.models).toEqual([
		{ id: 'actual-model', label: 'Actual model', default: true },
		{ id: 'other-model', label: 'Other model' },
	])
	expect('default' in view.models[1]!).toBe(false)
})

it("passes the engine's own current flag through the models handler", async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'claude-code')
	f.dependencies.models.mockImplementationOnce(async () => [
		{ id: 'opus', label: 'Opus 5.5', current: true } as HarnessModel,
		{ id: 'claude-opus-4-8', label: 'Opus 4.8' },
	])
	const view = await f.runtime.models('claude-code', f.sessionId)
	expect(view.models).toEqual([
		{ id: 'opus', label: 'Opus 5.5', current: true },
		{ id: 'claude-opus-4-8', label: 'Opus 4.8' },
	])
})

it('keeps a model selection exclusive while it awaits refreshed engine metadata', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	const metadata = deferred<readonly HarnessModel[]>()
	const entered = deferred<void>()
	f.dependencies.models.mockImplementationOnce(async () => {
		entered.resolve()
		return [...(await metadata.promise)]
	})
	const refreshing = f.runtime.models('codex-cli', f.sessionId)
	await entered.promise
	const selecting = f.runtime.selectProvider(f.sessionId, 'codex-cli', 'other-model')
	await expect(f.prompt()).rejects.toThrow('already connecting')
	await expect(f.runtime.selectHarness(f.sessionId, 'claude-code')).rejects.toThrow(
		'before changing its engine',
	)
	await expect(f.runtime.selectProvider(f.sessionId, 'codex-cli', 'actual-model')).rejects.toThrow(
		'before changing its model',
	)
	expect(await f.runtime.providerStatus(f.sessionId)).toMatchObject({
		selected: { id: 'codex-cli', model: 'actual-model' },
	})
	metadata.resolve([
		{ id: 'actual-model', label: 'Actual model' },
		{ id: 'other-model', label: 'Other model' },
	])
	await refreshing
	await selecting
	await f.prompt()
	expect(f.adapter.open).toHaveBeenCalledWith(
		expect.objectContaining({ model: 'other-model' }),
		expect.any(Function),
	)
	expect(f.base.gateway.prompt).not.toHaveBeenCalled()
})

it('reserves a prompt before awaited metadata and prevents a competing engine or model change', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	const metadata = deferred<readonly HarnessModel[]>()
	const entered = deferred<void>()
	f.dependencies.models.mockImplementationOnce(async () => {
		entered.resolve()
		return [...(await metadata.promise)]
	})
	const refreshing = f.runtime.models('codex-cli', f.sessionId)
	await entered.promise
	const sending = f.prompt()
	await expect(f.prompt('Duplicate')).rejects.toThrow('already connecting')
	await expect(f.runtime.selectHarness(f.sessionId, 'claude-code')).rejects.toThrow(
		'before changing its engine',
	)
	await expect(f.runtime.selectProvider(f.sessionId, 'codex-cli', 'other-model')).rejects.toThrow(
		'before changing its model',
	)
	expect(f.adapter.open).not.toHaveBeenCalled()
	metadata.resolve([{ id: 'actual-model', label: 'Actual model' }])
	await refreshing
	await expect(sending).resolves.toMatchObject({ stopReason: 'end_turn' })
	expect(f.adapter.open).toHaveBeenCalledWith(
		expect.objectContaining({ model: 'actual-model' }),
		expect.any(Function),
	)
	expect(f.base.gateway.prompt).not.toHaveBeenCalled()
})

it('retains the reservation until the original Namzu prompt has actually completed', async () => {
	const f = await fixture()
	const completion = deferred<{ stopReason: 'end_turn' }>()
	const entered = deferred<void>()
	vi.mocked(f.base.gateway.prompt).mockImplementationOnce(async () => {
		entered.resolve()
		return completion.promise
	})
	const sending = f.prompt()
	await entered.promise
	await expect(f.runtime.selectHarness(f.sessionId, 'codex-cli')).rejects.toThrow(
		'before changing its engine',
	)
	await expect(f.runtime.selectProvider(f.sessionId, 'zen', 'foreign')).rejects.toThrow(
		'before changing its model',
	)
	await expect(f.prompt('Duplicate')).rejects.toThrow('already connecting')
	expect(f.dependencies.models).not.toHaveBeenCalled()
	completion.resolve({ stopReason: 'end_turn' })
	await sending
	expect((await f.runtime.selectHarness(f.sessionId, 'codex-cli')).selected).toBe('codex-cli')
	expect(f.adapter.open).not.toHaveBeenCalled()
})

it('releases a failed selection and refreshes model metadata before allowing a removed model', async () => {
	const f = await fixture()
	f.dependencies.models.mockRejectedValueOnce(new Error('Native metadata unavailable'))
	await expect(f.runtime.selectHarness(f.sessionId, 'codex-cli')).rejects.toThrow(
		'Native metadata unavailable',
	)
	await f.prompt()
	expect(f.base.gateway.prompt).toHaveBeenCalledOnce()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	f.dependencies.models.mockResolvedValueOnce([{ id: 'other-model', label: 'Other model' }])
	expect(await f.runtime.models('codex-cli', f.sessionId)).toMatchObject({
		models: [{ id: 'other-model', label: 'Other model' }],
	})
	await expect(f.runtime.selectProvider(f.sessionId, 'codex-cli', 'actual-model')).rejects.toThrow(
		'listed by this engine',
	)
	await expect(f.prompt()).rejects.toThrow('listed by this engine')
	expect(f.adapter.open).not.toHaveBeenCalled()
	await f.runtime.selectProvider(f.sessionId, 'codex-cli', 'other-model')
	await expect(f.prompt()).resolves.toMatchObject({ stopReason: 'end_turn' })
})

it('refuses an external draft if another writer binds its disk journal to Namzu before dispatch', async () => {
	const f = await fixture()
	await f.runtime.selectHarness(f.sessionId, 'codex-cli')
	const state = await f.dependencies.openSessions(f.root)
	try {
		const log = openConversationLog(state, f.sessionId)
		const lease = await log.claim({ holder: 'concurrent-namzu-writer', ttlMs: 10_000 })
		if (!lease) throw new Error('Expected an uncontested fixture journal lease.')
		try {
			await log.append(lease, {
				type: 'session_started',
				projectId: state.projectId,
				tenantId: state.tenantId,
				topicId: state.topicId,
				cwd: state.projectRoot,
				agent: { id: 'namzu', name: 'Namzu' },
				origin: { protocol: 'cli' },
			})
		} finally {
			await log.release(lease)
		}
	} finally {
		closeSessions(state)
	}
	await expect(f.prompt()).rejects.toThrow('already bound to the Namzu engine')
	await expect(f.runtime.selectProvider(f.sessionId, 'codex-cli', 'actual-model')).rejects.toThrow(
		'already bound to the Namzu engine',
	)
	await expect(f.runtime.providerStatus(f.sessionId)).rejects.toThrow(
		'already bound to the Namzu engine',
	)
	expect(f.base.gateway.prompt).not.toHaveBeenCalled()
	expect(f.base.selectProvider).not.toHaveBeenCalled()
	expect(f.base.providerStatus).not.toHaveBeenCalled()
	expect(f.dependencies.adapter).not.toHaveBeenCalled()
	expect(f.adapter.open).not.toHaveBeenCalled()
})
