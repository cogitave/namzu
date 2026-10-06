import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from '@namzu/sdk'
import {
	ACPServer,
	DiskSessionLog,
	DiskTaskStore,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	MockLLMProvider,
	ToolManager,
	asSessionId,
	createToolPresenter,
	createUserMessage,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
	getBuiltinTools,
	toolset,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import {
	archiveConversation,
	closeSessions,
	loadConversation,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import * as sessionStorage from '../../integrations/sessions/store.js'
import { claimPalConversation } from '../../pals/conversations.js'
import * as palConversations from '../../pals/conversations.js'
import { createPal, getPalRevision, listPals } from '../../pals/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-host-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

it('does not treat an unreadable task as a deletion or expose its parse error', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	try {
		const store = new DiskTaskStore({
			paths: state.paths,
			session: { sessionId },
			tenantId: state.tenantId,
		})
		const task = await store.create({
			sessionId,
			turnId: generateTurnId(),
			subject: 'Important work',
		})
		writeFileSync(state.paths.taskFile({ sessionId }, task.id), '{PRIVATE_BROKEN_RECORD')
		await expect(host['namzu/tasks/list']({ sessionId })).rejects.toThrow(
			'Task list unavailable; its records could not be read completely.',
		)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('authorizes and reads tasks through the same state if the application home changes during lookup', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const replacementHome = join(root, 'replacement-state')
	mkdirSync(replacementHome)
	try {
		const store = new DiskTaskStore({
			paths: state.paths,
			session: { sessionId },
			tenantId: state.tenantId,
		})
		const originalTask = await store.create({
			sessionId,
			turnId: generateTurnId(),
			subject: 'Authorized work',
		})
		vi.stubEnv('NAMZU_HOME', replacementHome)
		const replacement = await openSessions(cwd)
		try {
			await new DiskTaskStore({
				paths: replacement.paths,
				session: { sessionId },
				tenantId: replacement.tenantId,
			}).create({ sessionId, turnId: generateTurnId(), subject: 'UNAUTHORIZED_REPLACEMENT_RECORD' })
		} finally {
			closeSessions(replacement)
		}
		vi.stubEnv('NAMZU_HOME', state.root)
		const actualOpen = sessionStorage.openSessions
		const opened = vi.spyOn(sessionStorage, 'openSessions').mockImplementation(async (...args) => {
			const selected = await actualOpen(...args)
			const get = selected.store.getSession.bind(selected.store)
			selected.store.getSession = async (...lookup) => {
				const result = await get(...lookup)
				vi.stubEnv('NAMZU_HOME', replacementHome)
				return result
			}
			return selected
		})
		expect(await host['namzu/tasks/list']({ sessionId })).toMatchObject({
			tasks: [{ taskId: originalTask.id, subject: 'Authorized work' }],
		})
		expect(opened).toHaveBeenCalledTimes(1)
	} finally {
		vi.stubEnv('NAMZU_HOME', state.root)
		closeSessions(state)
		await owner.close()
	}
})

it('refuses a Pal task snapshot when its captured claim disappears during authorization', async () => {
	const pal = createPal({ name: 'Task ownership fixture' })
	const owner = runtime()
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	const host = createDesktopHostExtensions(owner, pal.workspace)
	const lookup = vi.spyOn(palConversations, 'palConversationBinding').mockResolvedValueOnce(null)
	try {
		await expect(host['namzu/tasks/list']({ sessionId })).rejects.toThrow(
			'This conversation is not claimed by this Pal.',
		)
	} finally {
		lookup.mockRestore()
		await owner.close()
	}
})
function runtime() {
	return createCliAcpRuntime(
		{
			config: {},
			formatter: {
				name: 'text',
				print: () => {},
				info: () => {},
				error: () => {},
			},
		},
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
}
async function seeded(prompt = 'Stored request', id?: ReturnType<typeof generateSessionId>) {
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state, id)
	await drainQuery({
		provider: new MockLLMProvider({ responseText: 'Stored answer' }),
		messages: [createUserMessage(prompt)],
		toolsets: [],
		agentId: 'fixture',
		agentName: 'Fixture',
		sessionLog: DiskSessionLog.at(state.paths, { sessionId }),
		sessionId,
		tenantId: state.tenantId,
		projectId: state.projectId,
		topicId: state.topicId,
		workingDirectory: cwd,
		turnConfig: {
			model: 'mock',
			maxIterations: 2,
			tokenBudget: 100_000,
			timeoutMs: 30_000,
		},
	})
	return { state, sessionId }
}
it('requires exact affirmative folder trust before reading conversations', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	expect(host['namzu/project/status']()).toMatchObject({ trusted: false })
	await expect(host['namzu/conversations/list']()).rejects.toThrow('Trust this folder')
	await expect(
		host['namzu/conversations/history']({ sessionId: generateSessionId() }),
	).rejects.toThrow('Trust this folder')
	expect(() => host['namzu/project/trust']({ confirmed: true, cwd: root })).toThrow(
		'does not match',
	)
	expect(host['namzu/project/trust']({ confirmed: true, cwd })).toMatchObject({
		trusted: true,
	})
	expect(await host['namzu/conversations/list']()).toEqual([])
	await owner.close()
})

it('restores only the owned durable task list without leaking private planning fields', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	await expect(host['namzu/tasks/list']({ sessionId: generateSessionId() })).rejects.toThrow(
		'Trust this folder',
	)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	try {
		const taskStore = new DiskTaskStore({
			paths: state.paths,
			session: { sessionId },
			tenantId: state.tenantId,
		})
		const failed = await taskStore.create({
			sessionId,
			turnId: generateTurnId(),
			subject: 'Source unavailable',
			owner: 'Researcher',
			description: 'PRIVATE_DESCRIPTION',
			metadata: { secret: 'PRIVATE_METADATA' },
		})
		await taskStore.update(failed.id, { status: 'failed' })
		const next = await taskStore.create({
			sessionId,
			turnId: generateTurnId(),
			subject: 'Decide next step',
		})
		await taskStore.block(failed.id, next.id)
		await taskStore.create({
			sessionId,
			turnId: generateTurnId(),
			tenantId: generateTenantId(),
			subject: 'OTHER_TENANT',
		})
		// A newly constructed host reads disk before any model turn has run on
		// this connection. Its task store is not the current agent's cache.
		const fresh = createDesktopHostExtensions(owner, cwd)
		expect(await fresh['namzu/tasks/list']({ sessionId })).toEqual({
			tasks: [
				{
					taskId: failed.id,
					subject: failed.subject,
					status: 'failed',
					blockedBy: [],
					owner: 'Researcher',
				},
				{
					taskId: next.id,
					subject: next.subject,
					status: 'pending',
					blockedBy: [failed.id],
				},
			],
		})
		await taskStore.delete(next.id)
		expect((await fresh['namzu/tasks/list']({ sessionId })).tasks).toHaveLength(1)
		await expect(fresh['namzu/tasks/list']({ sessionId: generateSessionId() })).rejects.toThrow(
			'does not belong',
		)
		const foreign = join(root, 'foreign-tasks')
		mkdirSync(join(foreign, '.git'), { recursive: true })
		const foreignHost = createDesktopHostExtensions(owner, foreign)
		foreignHost['namzu/project/trust']({ confirmed: true, cwd: foreign })
		await expect(foreignHost['namzu/tasks/list']({ sessionId })).rejects.toThrow('does not belong')
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('prepares the selected provider on a real fresh ACP slot before its first journal and rejects unpublished, foreign and stopped slots', async () => {
	const foreign = join(root, 'foreign')
	mkdirSync(foreign)
	const presenter = createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] }))
	const createSession = vi.fn(async (_preferences: Preferences) => ({
		hasProvider: true,
		errorHint: null,
		mcpFailed: [],
		presenter,
		close: async () => {},
		send: async function* () {
			yield { kind: 'done', stopReason: 'end_turn' } as const
		},
	}))
	const owner = createCliAcpRuntime(
		{
			config: {},
			formatter: {
				name: 'text',
				print: () => {},
				info: () => {},
				error: () => {},
			},
		},
		{
			probe: async () => ({
				preferences: {
					version: 3,
					providers: [{ id: 'anthropic' }],
					subagents: { active: [] },
				},
				detected: [
					{
						entry: PROVIDER_REGISTRY.zen,
						source: { kind: 'public' },
						alternatives: [],
					},
				],
				needsRepickReason: null,
				credentialGap: {
					providerId: 'anthropic',
					reason: 'Fixture missing provider.',
				},
			}),
			createSession,
			decideTrust: decideHeadlessTrust,
			resolveProjectContext: (ctx) => ctx,
			resolveSession: async (id) => ({ sessionId: asSessionId(id) }),
		},
	)
	let receive!: (message: MCPJsonRpcMessage) => void
	let sequence = 0
	const waiting = new Map<number, (message: MCPJsonRpcMessage) => void>()
	const transport: MCPTransport = {
		connect: async () => {},
		close: async () => {},
		isConnected: () => true,
		onMessage: (handler) => {
			receive = handler
		},
		onClose: () => {},
		onError: () => {},
		send: async (message) => {
			if (typeof message.id === 'number') {
				waiting.get(message.id)?.(message)
				waiting.delete(message.id)
			}
		},
	}
	const request = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<MCPJsonRpcMessage>((resolve) => {
			const id = ++sequence
			waiting.set(id, resolve)
			receive({ jsonrpc: '2.0', id, method, params })
		})
	const host = createDesktopHostExtensions(owner, cwd, (id) => server.getSessionCwd(id))
	const server: ACPServer = new ACPServer({
		transport,
		gateway: owner.gateway,
		commands: new HostCommandRegistry(),
		presenter,
		agentInfo: { name: 'namzu', version: 'fixture' },
		extensions: host,
	})
	try {
		await server.start()
		await request('initialize', { capabilities: ['permission'] })
		await request('namzu/project/trust', { confirmed: true, cwd })
		const created = await request('session/new', { cwd })
		const sessionId = (created.result as { sessionId: string }).sessionId
		const state = await openSessions(cwd)
		try {
			expect(await state.store.getSession(asSessionId(sessionId), state.tenantId)).toBeNull()
		} finally {
			closeSessions(state)
		}
		expect(createSession).not.toHaveBeenCalled()
		expect(
			await request('namzu/providers/select', {
				sessionId,
				provider: 'zen',
				model: 'space-bunny-free',
			}),
		).toMatchObject({ result: { selected: true } })
		expect(await request('namzu/providers/status', { sessionId })).toMatchObject({
			result: { selected: { id: 'zen', model: 'space-bunny-free' } },
		})
		expect(createSession).not.toHaveBeenCalled()
		expect(
			await request('session/prompt', {
				sessionId,
				prompt: 'Fixture prompt; no real provider.',
				cwd,
			}),
		).toMatchObject({ result: { stopReason: 'end_turn' } })
		expect(createSession.mock.calls[0]?.[0]).toMatchObject({
			providers: [{ id: 'zen', model: 'space-bunny-free' }],
		})
		const foreignCreated = await request('session/new', { cwd: foreign })
		const foreignId = (foreignCreated.result as { sessionId: string }).sessionId
		for (const id of [foreignId, fixtureUuid('unpublished-native-session')])
			expect(
				await request('namzu/providers/select', {
					sessionId: id,
					provider: 'zen',
					model: 'space-bunny-free',
				}),
			).toMatchObject({
				error: {
					message: 'This conversation does not belong to this project.',
				},
			})
		await server.stop()
		await expect(host['namzu/providers/status']({ sessionId })).rejects.toThrow('does not belong')
	} finally {
		await server.stop()
		await owner.close()
	}
})
it('reads fresh journal history without opening the installation index, while listing remains indexed', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const indexed = vi.spyOn(sdk, 'openSessionIndex')
	const opened = vi.spyOn(sessionStorage, 'openSessionScope')
	try {
		expect((await host['namzu/conversations/history']({ sessionId })).messages).toContainEqual({
			role: 'user',
			text: 'Stored request',
		})
		await recordTurn(state, sessionId, [createUserMessage('Newer durable message')])
		expect((await host['namzu/conversations/history']({ sessionId })).messages.at(-1)).toEqual({
			role: 'user',
			text: 'Newer durable message',
		})
		expect(opened).toHaveBeenCalledTimes(2)
		expect(indexed).not.toHaveBeenCalled()
		expect(await host['namzu/conversations/list']()).toContainEqual(
			expect.objectContaining({ id: sessionId }),
		)
		expect(indexed).toHaveBeenCalledTimes(1)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('refuses history if the captured folder trust is revoked while preparing its scope', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const actualOpen = sessionStorage.openSessionScope
	const catalogRead = vi.fn()
	vi.spyOn(sessionStorage, 'openSessionScope').mockImplementation(async (...args) => {
		const scope = await actualOpen(...args)
		writeFileSync(join(scope.root, 'trust.json'), JSON.stringify({ version: 1, trusted: [] }))
		const get = scope.store.getSession.bind(scope.store)
		scope.store.getSession = (...lookup) => {
			catalogRead()
			return get(...lookup)
		}
		return scope
	})
	try {
		await expect(host['namzu/conversations/history']({ sessionId })).rejects.toThrow(
			'Trust this folder',
		)
		expect(catalogRead).not.toHaveBeenCalled()
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('authorizes and reads history through one state if the application home changes during lookup', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const replacementHome = join(root, 'replacement-history-state')
	mkdirSync(replacementHome)
	vi.stubEnv('NAMZU_HOME', replacementHome)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const replacement = await seeded('PRIVATE_REPLACEMENT_HISTORY', sessionId)
	vi.stubEnv('NAMZU_HOME', state.root)
	const actualOpen = sessionStorage.openSessionScope
	const opened = vi
		.spyOn(sessionStorage, 'openSessionScope')
		.mockImplementation(async (...args) => {
			const selected = await actualOpen(...args)
			const get = selected.store.getSession.bind(selected.store)
			selected.store.getSession = async (...lookup) => {
				const result = await get(...lookup)
				vi.stubEnv('NAMZU_HOME', replacementHome)
				return result
			}
			return selected
		})
	try {
		expect(await host['namzu/conversations/history']({ sessionId })).toEqual({
			partial: false,
			messages: [
				{ role: 'user', text: 'Stored request' },
				{ role: 'assistant', text: 'Stored answer' },
			],
		})
		expect(opened).toHaveBeenCalledTimes(1)
	} finally {
		vi.stubEnv('NAMZU_HOME', state.root)
		closeSessions(replacement.state)
		closeSessions(state)
		await owner.close()
	}
})

it.each(['tenant', 'project'] as const)(
	'refuses history whose real journal names a different %s',
	async (scope) => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const state = await openSessions(cwd)
		try {
			const wrongScope =
				scope === 'tenant'
					? { ...state, tenantId: generateTenantId() }
					: { ...state, projectId: generateProjectId() }
			const sessionId = await startConversation(wrongScope)
			const opened = vi.spyOn(sessionStorage, 'openSessionScope')
			await expect(host['namzu/conversations/history']({ sessionId })).rejects.toThrow(
				/does not belong/,
			)
			expect(opened).toHaveBeenCalledTimes(1)
		} finally {
			closeSessions(state)
			await owner.close()
		}
	},
)

it('refuses a corrupt history instead of returning its readable prefix', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	try {
		appendFileSync(state.paths.sessionLog({ sessionId }), '{PRIVATE_BROKEN_RECORD}\n')
		const opened = vi.spyOn(sessionStorage, 'openSessionScope')
		await expect(host['namzu/conversations/history']({ sessionId })).rejects.toThrow()
		expect(opened).toHaveBeenCalledTimes(1)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it("refuses durable Pal history without that Pal's claim", async () => {
	const pal = createPal({ name: 'History ownership fixture' })
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, pal.workspace)
	const state = await openSessions(pal.workspace)
	try {
		const sessionId = await startConversation(state)
		const opened = vi.spyOn(sessionStorage, 'openSessionScope')
		await expect(host['namzu/conversations/history']({ sessionId })).rejects.toThrow(
			'This conversation is not claimed by this Pal.',
		)
		expect(opened).toHaveBeenCalledTimes(1)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('loads durable history through the CLI gateway and refuses another project or archived writer', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	try {
		const loaded = await owner.gateway.load?.(sessionId, cwd)
		expect(JSON.stringify(loaded)).toContain('Stored request')
		expect(JSON.stringify(loaded)).toContain('Stored answer')
		const projection = await host['namzu/conversations/history']({ sessionId })
		expect(projection).toMatchObject({
			partial: false,
			messages: [
				{ role: 'user', text: 'Stored request' },
				{ role: 'assistant', text: 'Stored answer' },
			],
		})
		const foreign = join(root, 'foreign')
		mkdirSync(join(foreign, '.git'), { recursive: true })
		createDesktopHostExtensions(owner, foreign)['namzu/project/trust']({
			confirmed: true,
			cwd: foreign,
		})
		await expect(owner.gateway.load?.(sessionId, foreign)).rejects.toThrow()
		await expect(
			createDesktopHostExtensions(owner, foreign)['namzu/conversations/history']({ sessionId }),
		).rejects.toThrow()
		await archiveConversation(state, sessionId)
		await expect(owner.gateway.load?.(sessionId, cwd)).rejects.toThrow(/archived/)
		expect(await host['namzu/conversations/history']({ sessionId })).toEqual(projection)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('marks history partial when a single message exceeds the display ceiling', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded('x'.repeat(40_000))
	try {
		const result = await host['namzu/conversations/history']({ sessionId })
		expect(result.partial).toBe(true)
		expect(result.messages[0]?.text).toHaveLength(32_000)
		expect(result.messages[1]?.text).toBe('Stored answer')
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('restores Pal delivered replies from the admitted home while retaining private narration in its journal', async () => {
	const pal = createPal({ name: 'Chat fixture' })
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, pal.workspace)
	const state = await openSessions(pal.workspace)
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	try {
		await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						text: 'Internal pre-tool narration',
						toolCalls: [{ name: 'fixture_guest', args: { path: 'fixture.txt' } }],
					},
					{ text: 'Your requested result is ready.' },
				],
			}),
			messages: [createUserMessage('Prepare the result')],
			toolsets: [
				toolset('fixture', [
					{
						...getBuiltinTools().find((tool) => tool.name === 'read')!,
						name: 'fixture_guest',
						description: 'Fixture operation',
						execute: async () => ({ success: true, output: 'Completed' }),
					},
				]),
			],
			agentId: 'fixture',
			agentName: pal.name,
			sessionLog: DiskSessionLog.at(state.paths, { sessionId }),
			sessionId,
			tenantId: state.tenantId,
			projectId: state.projectId,
			topicId: state.topicId,
			turnConfig: {
				model: 'mock',
				maxIterations: 3,
				tokenBudget: 100_000,
				timeoutMs: 30_000,
			},
		})
		const replacementHome = join(root, 'replacement-pal-history-state')
		mkdirSync(replacementHome)
		vi.stubEnv('NAMZU_HOME', replacementHome)
		host['namzu/project/trust']({ confirmed: true, cwd: pal.workspace })
		vi.stubEnv('NAMZU_HOME', state.root)
		const actualOpen = sessionStorage.openSessionScope
		const opened = vi
			.spyOn(sessionStorage, 'openSessionScope')
			.mockImplementation(async (...args) => {
				const selected = await actualOpen(...args)
				const get = selected.store.getSession.bind(selected.store)
				selected.store.getSession = async (...lookup) => {
					const result = await get(...lookup)
					vi.stubEnv('NAMZU_HOME', replacementHome)
					return result
				}
				return selected
			})
		const projection = await host['namzu/conversations/history']({ sessionId })
		expect(projection.messages).toEqual([
			{ role: 'user', text: 'Prepare the result' },
			{ role: 'assistant', text: 'Your requested result is ready.' },
		])
		expect(projection.partial).toBe(false)
		expect(opened).toHaveBeenCalledTimes(1)
		vi.stubEnv('NAMZU_HOME', state.root)
		const original = await loadConversation(state, sessionId)
		expect(
			original.some(
				(message) =>
					message.role === 'assistant' &&
					message.content === 'Internal pre-tool narration' &&
					message.toolCalls?.length,
			),
		).toBe(true)
		expect(original.some((message) => message.role === 'tool')).toBe(true)
	} finally {
		vi.stubEnv('NAMZU_HOME', state.root)
		closeSessions(state)
		await owner.close()
	}
})

it('persists appearance through the actual desktop ACP extensions and keeps earlier revisions unchanged', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	try {
		const pal = host['namzu/pals/create']({
			name: 'Chosen',
			appearance: { character: 'spark', color: 'blue' },
		})
		expect(pal.appearance).toEqual({ character: 'spark', color: 'blue' })
		const updated = await host['namzu/pals/update']({
			id: pal.id,
			expectedRevision: 1,
			appearance: { character: 'sprout', color: 'amber' },
		})
		expect(updated.appearance).toEqual({ character: 'sprout', color: 'amber' })
		expect(host['namzu/pals/get']({ id: pal.id })?.appearance).toEqual(updated.appearance)
		expect(getPalRevision(pal.id, 1).appearance).toEqual(pal.appearance)
		await expect(
			host['namzu/pals/update']({
				id: pal.id,
				expectedRevision: 2,
				appearance: { character: 'spark', color: 'invalid' },
			}),
		).rejects.toThrow('appearance')
		expect(host['namzu/pals/get']({ id: pal.id })?.revision).toBe(2)
		expect(() =>
			host['namzu/pals/create']({
				name: 'Bad',
				appearance: { character: 'spark', color: 'blue', script: 'bad' },
			}),
		).toThrow('appearance')
		expect(listPals()).toHaveLength(1)
	} finally {
		await owner.close()
	}
})
