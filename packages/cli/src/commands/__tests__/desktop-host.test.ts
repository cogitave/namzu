import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as sdk from '@namzu/sdk'
import {
	ACPServer,
	DiskSessionLog,
	DiskTaskStore,
	type HarnessAdapter,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	type Message,
	MockLLMProvider,
	PalRuntime,
	ToolManager,
	asSessionId,
	createAssistantMessage,
	createToolMessage,
	createToolPresenter,
	createUserMessage,
	drainQuery,
	generateMessageId,
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
import * as palEnvironment from '../../pals/environment.js'
import { createPal, getCliPalStore, getPal, getPalRevision, listPals } from '../../pals/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { withCliHarnesses } from '../acp-harness.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'
import { providerPaused } from './support/provider-paused.js'

let root: string
let cwd: string
const withoutJournalMetadata = <T extends { time?: unknown; messageId?: string }>(
	rows: readonly T[],
) => rows.map(({ time: _time, messageId: _messageId, ...row }) => row)
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-host-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.useRealTimers()
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
function runtime(overrides: Partial<AcpRuntimeDependencies> = {}) {
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
			...overrides,
		} as unknown as AcpRuntimeDependencies,
	)
}

it('admits live input only for the current published ordinary slot after fresh scoped ownership', async () => {
	const owner = runtime()
	const sessionId = generateSessionId()
	const foreign = generateSessionId()
	const status = vi
		.spyOn(owner, 'liveInputStatus')
		.mockResolvedValue({ available: true, scopeId: 'scope', inputs: [] })
	const accept = vi
		.spyOn(owner, 'liveInput')
		.mockResolvedValue({ accepted: true, scopeId: 'scope', inputId: 'entry' })
	const host = createDesktopHostExtensions(owner, cwd, (id) => (id === sessionId ? cwd : undefined))
	host['namzu/project/trust']({ confirmed: true, cwd })
	const indexed = vi.spyOn(sessionStorage, 'openSessions')
	try {
		expect(await host['namzu/conversations/input/status']?.({ sessionId })).toEqual({
			available: true,
			scopeId: 'scope',
			inputs: [],
		})
		expect(
			await host['namzu/conversations/input']?.({
				sessionId,
				scopeId: 'scope',
				inputId: 'entry',
				prompt: '  Exact operator text  ',
			}),
		).toEqual({ accepted: true, scopeId: 'scope', inputId: 'entry' })
		expect(accept).toHaveBeenCalledWith(
			sessionId,
			{
				scopeId: 'scope',
				inputId: 'entry',
				prompt: '  Exact operator text  ',
			},
			expect.objectContaining({ root: join(root, 'state') }),
		)
		await expect(
			host['namzu/conversations/input']?.({
				sessionId: foreign,
				scopeId: 'scope',
				inputId: 'entry',
				prompt: 'Foreign text',
			}),
		).rejects.toThrow('does not belong')
		await expect(
			host['namzu/conversations/input']?.({
				sessionId,
				scopeId: 'scope',
				inputId: 'entry',
				prompt: 'Text',
				options: { permissionMode: 'auto' },
			}),
		).rejects.toThrow('accepts only')
		expect(accept).toHaveBeenCalledTimes(1)
		expect(status).toHaveBeenCalledTimes(1)
		expect(indexed).not.toHaveBeenCalled()
	} finally {
		await owner.close()
	}
})

it.each(['slot', 'home'] as const)(
	'refuses live input after its %s changes during authorization',
	async (change) => {
		const owner = runtime()
		const sessionId = generateSessionId()
		const accept = vi
			.spyOn(owner, 'liveInput')
			.mockResolvedValue({ accepted: true, scopeId: 'scope', inputId: 'entry' })
		let published: string | undefined = cwd
		const host = createDesktopHostExtensions(owner, cwd, (id) =>
			id === sessionId ? published : undefined,
		)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const actual = sessionStorage.openSessionScope
		vi.spyOn(sessionStorage, 'openSessionScope').mockImplementation(async (...args) => {
			const scope = await actual(...args)
			const read = scope.store.getSession.bind(scope.store)
			scope.store.getSession = async (...lookup) => {
				const result = await read(...lookup)
				if (change === 'slot') published = undefined
				else {
					mkdirSync(join(root, 'replacement'))
					vi.stubEnv('NAMZU_HOME', join(root, 'replacement'))
				}
				return result
			}
			return scope
		})
		try {
			await expect(
				host['namzu/conversations/input']?.({
					sessionId,
					scopeId: 'scope',
					inputId: 'entry',
					prompt: 'Retain me',
				}),
			).rejects.toThrow(change === 'slot' ? 'does not belong' : 'owned ordinary')
			expect(accept).not.toHaveBeenCalled()
		} finally {
			await owner.close()
		}
	},
)
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
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
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
		expect(indexed).not.toHaveBeenCalled()
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
		expect(
			withoutJournalMetadata((await host['namzu/conversations/history']({ sessionId })).messages),
		).toContainEqual({
			role: 'user',
			text: 'Stored request',
		})
		await recordTurn(state, sessionId, [createUserMessage('Newer durable message')])
		expect(
			(await host['namzu/conversations/history']({ sessionId })).messages.at(-1),
		).toMatchObject({
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

it('omits tool-only assistant history without truncating text, media placeholders or model replay', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	const calls = [
		{
			id: fixtureUuid('history-tool-only-call'),
			type: 'function' as const,
			function: { name: 'fixture_read', arguments: '{}' },
		},
	]
	const toolOnly = createAssistantMessage(null, calls, undefined, undefined, {
		type: 'model',
		providerId: 'mock',
		model: 'mock',
		chainIndex: 0,
	})
	const narration = createAssistantMessage('Checking the requested file.', calls)
	// Earlier/imported user-media records may have null content. The durable
	// record codec admits these bodies, though today's user constructor takes text.
	const media = {
		role: 'user',
		content: null,
		attachments: [{ data: 'AA==', mediaType: 'image/png' }],
	} as unknown as Message
	try {
		await recordTurn(state, sessionId, [
			createUserMessage('Check this file.'),
			toolOnly,
			createToolMessage('File content.', calls[0]!.id),
			narration,
			media,
			createAssistantMessage(null),
			createAssistantMessage('The file is ready.'),
		])
		const original = await loadConversation(state, sessionId)
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
		expect(await host['namzu/conversations/history']({ sessionId })).toMatchObject({
			messages: [
				{ role: 'user', text: 'Check this file.' },
				{ role: 'assistant', text: 'Checking the requested file.' },
				{ role: 'user', text: '[Media message]' },
				{ role: 'assistant', text: '[Media message]' },
				{ role: 'assistant', text: 'The file is ready.' },
			],
			partial: false,
		})
		expect(indexed).not.toHaveBeenCalled()
		expect(await loadConversation(state, sessionId)).toEqual(original)
		expect(original).toContainEqual(expect.objectContaining(toolOnly))
		expect(original).toContainEqual(expect.objectContaining(narration))
		expect(original).toContainEqual(expect.objectContaining({ role: 'tool' }))
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('restores only proven commentary and final phases from a fresh ordinary journal read', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	const commentary = {
		...createAssistantMessage('Checking the file.'),
		textParts: [{ id: 'progress', text: 'Checking the file.', phase: 'commentary' as const }],
	}
	const final = {
		...createAssistantMessage('Ready.'),
		textParts: [{ id: 'answer', text: 'Ready.', phase: 'final_answer' as const }],
	}
	const mixed = {
		...createAssistantMessage('Selected answer.'),
		textParts: [
			{ id: 'mixed-progress', text: 'More work.', phase: 'commentary' as const },
			{ id: 'mixed-answer', text: 'Selected answer.', phase: 'final_answer' as const },
		],
	}
	const ambiguous = {
		...createAssistantMessage('Commentary.\n\nUnphased.'),
		textParts: [
			{ id: 'ambiguous-progress', text: 'Commentary.', phase: 'commentary' as const },
			{ id: 'ambiguous-other', text: 'Unphased.' },
		],
	}
	const revised = {
		...createAssistantMessage('Revised answer.'),
		textParts: [{ id: 'old-answer', text: 'Old answer.', phase: 'final_answer' as const }],
	}
	try {
		await recordTurn(state, sessionId, [
			createUserMessage('Review the file.'),
			commentary,
			final,
			mixed,
			createAssistantMessage('Legacy answer.'),
			ambiguous,
			revised,
		])
		const original = await loadConversation(state, sessionId)
		const fresh = createDesktopHostExtensions(owner, cwd)
		expect(await fresh['namzu/conversations/history']({ sessionId })).toMatchObject({
			messages: [
				{ role: 'user', text: 'Review the file.' },
				{ role: 'assistant', text: 'Checking the file.', phase: 'commentary' },
				{ role: 'assistant', text: 'Ready.', phase: 'final_answer' },
				{ role: 'assistant', text: 'Selected answer.', phase: 'final_answer' },
				{ role: 'assistant', text: 'Legacy answer.' },
				{ role: 'assistant', text: 'Commentary.\n\nUnphased.' },
				{ role: 'assistant', text: 'Revised answer.' },
			],
			partial: false,
		})
		expect(await loadConversation(state, sessionId)).toEqual(original)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('keeps the Pal history filter unchanged while ordinary phase metadata is available', async () => {
	const pal = createPal({ name: 'Private commentary fixture' })
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, pal.workspace)
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	const state = await openSessions(pal.workspace)
	try {
		await recordTurn(state, sessionId, [
			createUserMessage('Report the result.'),
			{
				...createAssistantMessage('Private progress.'),
				textParts: [{ id: 'progress', text: 'Private progress.', phase: 'commentary' }],
			},
			{
				...createAssistantMessage('Public result.'),
				textParts: [
					{ id: 'more-progress', text: 'More private progress.', phase: 'commentary' },
					{ id: 'answer', text: 'Public result.', phase: 'final_answer' },
				],
			},
		])
		const history = await host['namzu/conversations/history']({ sessionId })
		expect(withoutJournalMetadata(history.messages)).toEqual([
			{ role: 'user', text: 'Report the result.' },
			{ role: 'assistant', text: 'Public result.' },
		])
		expect(history.partial).toBe(false)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('keeps an uncommitted stopped reply out of Pal history', async () => {
	const pal = createPal({ name: 'Stopped reply fixture' })
	const owner = runtime()
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	const state = await openSessions(pal.workspace)
	const log = sessionStorage.openConversationLog(state, sessionId)
	const lease = await log.claim({ holder: 'test:pal-stopped', ttlMs: 30_000 })
	if (!lease) throw new Error('fixture could not lease the Pal journal')
	try {
		const turnId = generateTurnId()
		const userMessageId = generateMessageId()
		await log.beginTurn(lease, {
			turnId,
			userMessageId,
			config: { model: 'fixture', tokenBudget: 100_000, timeoutMs: 30_000 },
		})
		await log.append(lease, {
			type: 'message',
			turnId,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: createUserMessage('Stop me'),
		})
		const messageId = generateMessageId()
		await log.append(lease, { type: 'message_started', turnId, iteration: 1, messageId })
		await log.append(lease, {
			type: 'message_completed',
			turnId,
			iteration: 1,
			messageId,
			content: 'Stopped partial.',
			stopReason: 'cancelled',
		})
	} finally {
		await log.release(lease)
	}
	try {
		const history = await createDesktopHostExtensions(owner, pal.workspace)[
			'namzu/conversations/history'
		]({ sessionId })
		expect(history.messages.map((row: { text: string }) => row.text)).toEqual(['Stop me'])
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('restores completed Pal replies but omits only unchanged, journal-proven cancelled partials', async () => {
	const pal = createPal({ name: 'Interrupted reply fixture' })
	const owner = runtime()
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	const state = await openSessions(pal.workspace)
	const log = sessionStorage.openConversationLog(state, sessionId)
	const lease = await log.claim({ holder: 'test:pal-history', ttlMs: 30_000 })
	if (!lease) throw new Error('fixture could not lease the Pal journal')
	const settlement = (
		status: 'cancelled' | 'failed',
		resultMessageId: ReturnType<typeof generateMessageId>,
	) => ({
		status,
		iterations: 1,
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		durationMs: 1,
		resultMessageId,
		resultSource: 'model' as const,
		abandonedTaskIds: [],
		abandonedJobIds: [],
	})
	const begin = async (prompt: string) => {
		const turnId = generateTurnId()
		const userMessageId = generateMessageId()
		await log.beginTurn(lease, {
			turnId,
			userMessageId,
			config: { model: 'fixture', tokenBudget: 100_000, timeoutMs: 30_000 },
		})
		await log.append(lease, {
			type: 'message',
			turnId,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: createUserMessage(prompt),
		})
		return turnId
	}
	const reply = async (
		turnId: ReturnType<typeof generateTurnId>,
		content: string,
		stopReason: 'end_turn' | 'cancelled',
	) => {
		const messageId = generateMessageId()
		await log.append(lease, {
			type: 'message',
			turnId,
			messageId,
			role: 'assistant',
			content: createAssistantMessage(content),
		})
		await log.append(lease, {
			type: 'message_completed',
			turnId,
			iteration: 0,
			messageId,
			content,
			stopReason,
		})
		return messageId
	}
	try {
		const interrupted = await begin('First task')
		await reply(interrupted, 'Completed before interruption.', 'end_turn')
		const partial = await reply(interrupted, 'Unfinished partial.', 'cancelled')
		await log.append(lease, {
			type: 'turn_completed',
			turnId: interrupted,
			result: 'Unfinished partial.',
			stopReason: 'cancelled',
			settlement: settlement('cancelled', partial),
		})

		const failed = await begin('Second task')
		const retained = await reply(failed, 'Completed before failure.', 'end_turn')
		await log.append(lease, {
			type: 'turn_failed',
			turnId: failed,
			error: 'Native turn failed.',
			settlement: settlement('failed', retained),
		})

		const failedPartial = await begin('Failed partial task')
		const failedPartialId = await reply(failedPartial, 'Failed partial.', 'cancelled')
		await log.append(lease, {
			type: 'turn_failed',
			turnId: failedPartial,
			error: 'Native turn failed.',
			settlement: settlement('failed', failedPartialId),
		})

		const revised = await begin('Third task')
		const revisedId = await reply(revised, 'Original partial.', 'cancelled')
		await log.append(lease, {
			type: 'turn_failed',
			turnId: revised,
			error: 'Native turn failed.',
			settlement: settlement('failed', revisedId),
		})
		await log.append(lease, {
			type: 'message_replaced',
			targetMessageId: revisedId,
			content: createAssistantMessage('Revised delivered answer.'),
			reason: 'history-repair',
		})
	} finally {
		await log.release(lease)
	}
	try {
		await recordTurn(
			state,
			sessionId,
			[createUserMessage('Legacy task'), createAssistantMessage('Legacy partial.')],
			{ status: 'failed' },
		)
		const original = await loadConversation(state, sessionId)
		expect(
			original.filter((message) => message.role === 'assistant').map((message) => message.content),
		).toEqual([
			'Completed before interruption.',
			'Unfinished partial.',
			'Completed before failure.',
			'Failed partial.',
			'Revised delivered answer.',
			'Legacy partial.',
		])
		const fresh = createDesktopHostExtensions(owner, pal.workspace)
		const history = await fresh['namzu/conversations/history']({ sessionId })
		expect(withoutJournalMetadata(history.messages)).toEqual([
			{ role: 'user', text: 'First task' },
			{ role: 'assistant', text: 'Completed before interruption.' },
			{ role: 'user', text: 'Second task' },
			{ role: 'assistant', text: 'Completed before failure.' },
			{ role: 'user', text: 'Failed partial task' },
			{ role: 'user', text: 'Third task' },
			{ role: 'assistant', text: 'Revised delivered answer.' },
			{ role: 'user', text: 'Legacy task' },
			{ role: 'assistant', text: 'Legacy partial.' },
		])
		expect(history.partial).toBe(false)
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
		expect(await host['namzu/conversations/history']({ sessionId })).toMatchObject({
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
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
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
		expect(indexed).not.toHaveBeenCalled()
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

it('reads fresh retry eligibility without an index or a model runtime', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd, undefined, vi.fn())
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const f = await providerPaused(state)
	const indexed = vi.spyOn(sdk, 'openSessionIndex')
	try {
		expect(await owner.providerRetryStatus!(f.sessionId, cwd)).toEqual({
			notice: expect.stringContaining('original approval settings'),
		})
		expect(await host['namzu/sessions/retry-status']!({ sessionId: f.sessionId })).toEqual({
			notice: expect.stringContaining('original approval settings'),
		})
		const lease = await f.log.claim({ holder: 'fresh-retry-read', ttlMs: 60_000 })
		if (!lease) throw new Error('Fixture writer unavailable')
		try {
			await f.log.append(lease, {
				type: 'turn_resuming',
				turnId: f.turnId,
				fromCheckpointId: f.checkpointId,
			})
		} finally {
			await f.log.release(lease)
		}
		expect(await host['namzu/sessions/retry-status']!({ sessionId: f.sessionId })).toEqual({
			notice: expect.stringContaining('active turn to settle'),
		})
		expect(indexed).not.toHaveBeenCalled()
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('keeps retry authorization, trust and status in the captured application home', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd, undefined, vi.fn())
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const f = await providerPaused(state)
	const replacementHome = join(root, 'replacement-retry-state')
	mkdirSync(replacementHome)
	vi.stubEnv('NAMZU_HOME', replacementHome)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const replacement = await seeded('Replacement complete conversation', f.sessionId)
	vi.stubEnv('NAMZU_HOME', state.root)
	const actualOpen = sessionStorage.openSessionScope
	const opened = vi
		.spyOn(sessionStorage, 'openSessionScope')
		.mockImplementation(async (...args) => {
			const scope = await actualOpen(...args)
			const get = scope.store.getSession.bind(scope.store)
			scope.store.getSession = async (...lookup) => {
				const result = await get(...lookup)
				vi.stubEnv('NAMZU_HOME', replacementHome)
				return result
			}
			return scope
		})
	const indexed = vi.spyOn(sdk, 'openSessionIndex')
	try {
		expect(await host['namzu/sessions/retry-status']!({ sessionId: f.sessionId })).toEqual({
			notice: expect.stringContaining('original approval settings'),
		})
		expect(opened).toHaveBeenCalledTimes(1)
		expect(indexed).not.toHaveBeenCalled()
	} finally {
		vi.stubEnv('NAMZU_HOME', state.root)
		closeSessions(replacement.state)
		closeSessions(state)
		await owner.close()
	}
})

it('refuses a foreign authenticated retry scope and revoked captured trust', async () => {
	const readRetryStatus = vi.fn(async () => ({}))
	const owner = runtime({ readRetryStatus })
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const foreign = join(root, 'foreign-retry')
	mkdirSync(join(foreign, '.git'), { recursive: true })
	const other = await sessionStorage.openSessionScope(foreign)
	try {
		await expect(owner.providerRetryStatus!(sessionId, cwd, other)).rejects.toThrow(
			'another project',
		)
		const scope = await sessionStorage.openSessionScope(cwd)
		writeFileSync(join(scope.root, 'trust.json'), JSON.stringify({ version: 1, trusted: [] }))
		await expect(owner.providerRetryStatus!(sessionId, cwd, scope)).rejects.toThrow(/Trust|trusted/)
		expect(readRetryStatus).not.toHaveBeenCalled()
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it.each(['load', 'retry'] as const)(
	'keeps direct %s in its original home when resolving the session changes ambient state',
	async (operation) => {
		const owner = runtime({
			resolveSession: async (id) => {
				vi.stubEnv('NAMZU_HOME', replacementHome)
				return { sessionId: asSessionId(id) }
			},
		})
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const state = await openSessions(cwd)
		const f = await providerPaused(state)
		const replacementHome = join(root, 'direct-read-replacement')
		mkdirSync(replacementHome)
		vi.stubEnv('NAMZU_HOME', replacementHome)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const replacement = await seeded('Replacement completed request', f.sessionId)
		vi.stubEnv('NAMZU_HOME', state.root)
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
		try {
			if (operation === 'load') {
				const loaded = JSON.stringify(await owner.gateway.load!(f.sessionId, cwd))
				expect(loaded).toContain('Continue the original robot task')
				expect(loaded).not.toContain('Replacement completed request')
			} else {
				expect(await owner.providerRetryStatus!(f.sessionId, cwd)).toEqual({
					notice: expect.stringContaining('original approval settings'),
				})
			}
			expect(indexed).not.toHaveBeenCalled()
		} finally {
			vi.stubEnv('NAMZU_HOME', state.root)
			closeSessions(replacement.state)
			closeSessions(state)
			await owner.close()
		}
	},
)

it.each(['load', 'retry'] as const)(
	'refuses direct %s when captured trust is revoked during scope preparation',
	async (operation) => {
		const binding = vi.fn(async () => null)
		const readRetryStatus = vi.fn(async () => ({}))
		const owner = runtime({
			palBinding: binding,
			readRetryStatus,
			openSessionScope: async (...args) => {
				const scope = await sessionStorage.openSessionScope(...args)
				writeFileSync(join(scope.root, 'trust.json'), JSON.stringify({ version: 1, trusted: [] }))
				return scope
			},
		})
		createDesktopHostExtensions(owner, cwd)['namzu/project/trust']({ confirmed: true, cwd })
		const { state, sessionId } = await seeded()
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
		try {
			await expect(
				operation === 'load'
					? owner.gateway.load!(sessionId, cwd)
					: owner.providerRetryStatus!(sessionId, cwd),
			).rejects.toThrow(/Trust|trusted/)
			expect(binding).not.toHaveBeenCalled()
			expect(readRetryStatus).not.toHaveBeenCalled()
			expect(indexed).not.toHaveBeenCalled()
		} finally {
			closeSessions(state)
			await owner.close()
		}
	},
)

it('preserves an embedding storage seam until an explicit direct-read seam replaces it', async () => {
	const { state, sessionId } = await seeded()
	const legacyOpen = vi.fn((directory: string) =>
		openSessions(directory, { stateRoot: state.root }),
	)
	const owner = runtime({ openSessions: legacyOpen })
	createDesktopHostExtensions(owner, cwd)['namzu/project/trust']({ confirmed: true, cwd })
	const read = vi.fn((directory: string) =>
		sessionStorage.openSessionScope(directory, { stateRoot: state.root }),
	)
	const direct = runtime({ openSessions: legacyOpen, openSessionScope: read })
	try {
		expect(await owner.gateway.load!(sessionId, cwd)).toHaveLength(2)
		expect(legacyOpen).toHaveBeenCalledTimes(1)
		const indexed = vi.spyOn(sdk, 'openSessionIndex')
		expect(await direct.gateway.load!(sessionId, cwd)).toHaveLength(2)
		expect(read).toHaveBeenCalledTimes(1)
		expect(legacyOpen).toHaveBeenCalledTimes(1)
		expect(indexed).not.toHaveBeenCalled()
	} finally {
		closeSessions(state)
		await owner.close()
		await direct.close()
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
		expect(withoutJournalMetadata(projection.messages)).toEqual([
			{ role: 'user', text: 'Prepare the result' },
			{ role: 'assistant', text: 'Your requested result is ready.' },
		])
		expect(projection.partial).toBe(false)
		expect(opened).toHaveBeenCalledTimes(1)
		vi.stubEnv('NAMZU_HOME', state.root)
		const original = await loadConversation(state, sessionId)
		expect(projection.messages.map((message) => message.messageId)).toEqual([
			original.find(
				(message) => message.role === 'user' && message.content === 'Prepare the result',
			)?.id,
			original.find(
				(message) =>
					message.role === 'assistant' && message.content === 'Your requested result is ready.',
			)?.id,
		])
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

it('logically deletes an offline Pal through the metadata host without initializing its computer', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	const pal = createPal({ name: 'Deleted fixture' })
	const proof = join(pal.workspace, 'retained.txt')
	writeFileSync(proof, 'Retained output')
	const initialize = vi.spyOn(palEnvironment, 'getCliPalRuntime')
	try {
		expect(await host['namzu/pals/delete']({ id: pal.id, expectedRevision: 1 })).toEqual({
			id: pal.id,
			deleted: true,
		})
		expect(host['namzu/pals/get']({ id: pal.id })).toBeNull()
		expect(host['namzu/pals/list']()).toEqual([])
		expect(getPalRevision(pal.id, 1)).toEqual(pal)
		expect(await host['namzu/pals/delete']({ id: pal.id, expectedRevision: 1 })).toEqual({
			id: pal.id,
			deleted: true,
		})
		await expect(
			host['namzu/pals/update']({ id: pal.id, expectedRevision: 1, paused: false }),
		).rejects.toThrow('does not exist')
		expect(initialize).not.toHaveBeenCalled()
		expect(readFileSync(proof, 'utf8')).toBe('Retained output')
	} finally {
		await owner.close()
	}
})

it('validates exact deletion identity and revision before reading any computer state', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	const pal = createPal({ name: 'Validation fixture' })
	const observed = vi.spyOn(palEnvironment, 'existingCliPalRuntime')
	try {
		for (const request of [
			{ id: '../escape', expectedRevision: 1 },
			{ id: pal.id, expectedRevision: 0 },
			{ id: pal.id, expectedRevision: 1.5 },
			{ id: pal.id, expectedRevision: Number.MAX_SAFE_INTEGER },
			{ id: pal.id, expectedRevision: '1' },
			{ id: pal.id },
			{ id: pal.id, expectedRevision: 1, purge: true },
		])
			await expect(host['namzu/pals/delete'](request)).rejects.toThrow('Invalid')
		expect(observed).not.toHaveBeenCalled()
		expect(getPal(pal.id)).toEqual(pal)
	} finally {
		await owner.close()
	}
})

it('refuses deletion of another Pal from an owned Pal workspace', async () => {
	const owner = runtime()
	const pal = createPal({ name: 'Owning fixture' })
	const other = createPal({ name: 'Other fixture' })
	try {
		await expect(
			createDesktopHostExtensions(owner, pal.workspace)['namzu/pals/delete']({
				id: other.id,
				expectedRevision: other.revision,
			}),
		).rejects.toThrow('does not own')
		expect(getPal(pal.id)).toEqual(pal)
		expect(getPal(other.id)).toEqual(other)
	} finally {
		await owner.close()
	}
})

it('retains the admitted home when observing the existing runtime yields to a home change', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	const pal = createPal({ name: 'Original home' })
	const originalHome = process.env.NAMZU_HOME!
	const replacementHome = join(root, 'replacement-delete-state')
	mkdirSync(replacementHome)
	vi.stubEnv('NAMZU_HOME', replacementHome)
	const unrelated = createPal({ name: 'Replacement home' })
	vi.stubEnv('NAMZU_HOME', originalHome)
	vi.spyOn(palEnvironment, 'existingCliPalRuntime').mockImplementation(async () => {
		vi.stubEnv('NAMZU_HOME', replacementHome)
		return null
	})
	try {
		expect(await host['namzu/pals/delete']({ id: pal.id, expectedRevision: 1 })).toEqual({
			id: pal.id,
			deleted: true,
		})
		expect(getPal(pal.id, originalHome)).toBeNull()
		expect(getPal(unrelated.id, replacementHome)).toEqual(unrelated)
		expect(getPalRevision(pal.id, 1, originalHome)).toEqual(pal)
	} finally {
		vi.stubEnv('NAMZU_HOME', originalHome)
		await owner.close()
	}
})

it('requires existing model authority and warm guest cleanup to finish before deleting a profile', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	const pal = createPal({ name: 'Lifecycle fixture' })
	const release = vi.fn(async () => {})
	const lease = {
		palId: pal.id,
		environmentId: 'fixture-environment',
		generation: 1,
		sandbox: { status: 'ready' } as sdk.Sandbox,
		computerUseHost: {
			capabilities: { screenshot: true, mouse: true, keyboard: true },
		} as sdk.ComputerUseHost,
		release,
	}
	const active = new PalRuntime({
		store: getCliPalStore(),
		environments: { acquire: async () => lease },
	})
	vi.spyOn(palEnvironment, 'existingCliPalRuntime').mockResolvedValue(active)
	try {
		const admission = await active.admitConversation({ palId: pal.id, conversationId: 'text' })
		await expect(host['namzu/pals/delete']({ id: pal.id, expectedRevision: 1 })).rejects.toThrow(
			'Stop this Pal',
		)
		await admission.release()
		await active.startComputer(pal.id)
		expect(active.busy(pal.id)).toBe(false)
		await expect(host['namzu/pals/delete']({ id: pal.id, expectedRevision: 1 })).rejects.toThrow(
			'Stop this Pal',
		)
		expect(getPal(pal.id)).toEqual(pal)
		expect(release).not.toHaveBeenCalled()
		await active.stopComputer(pal.id)
		expect(release).toHaveBeenCalledTimes(1)
		expect(await host['namzu/pals/delete']({ id: pal.id, expectedRevision: 1 })).toEqual({
			id: pal.id,
			deleted: true,
		})
	} finally {
		await active.close()
		await owner.close()
	}
})

it('archives owned settled history idempotently while preserving strict messages and immutable log bytes', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const file = state.paths.sessionLog({ sessionId })
	const before = readFileSync(file, 'utf8')
	const original = await loadConversation(state, sessionId)
	try {
		const response = { sessionId, archived: true }
		expect(await host['namzu/conversations/archive']({ sessionId })).toEqual(response)
		expect(await host['namzu/conversations/archive']({ sessionId })).toEqual(response)
		expect(await host['namzu/conversations/list']()).toEqual([])
		expect(
			withoutJournalMetadata((await host['namzu/conversations/history']({ sessionId })).messages),
		).toEqual([
			{ role: 'user', text: 'Stored request' },
			{ role: 'assistant', text: 'Stored answer' },
		])
		expect(await loadConversation(state, sessionId)).toEqual(original)
		expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true)
		const facts = await sessionStorage.readConversationFacts(state, sessionId)
		expect(facts?.archived).toBe(true)
		expect(
			facts?.records.filter((record) => record.type === 'session_updated' && record.archived),
		).toHaveLength(1)
		await expect(owner.gateway.load?.(sessionId, cwd)).rejects.toThrow('archived')
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('lists archived conversations and restores one back into the ordinary list', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	await expect(host['namzu/conversations/archived']({})).rejects.toThrow('Trust this folder')
	await expect(
		host['namzu/conversations/unarchive']({ sessionId: generateSessionId() }),
	).rejects.toThrow('Trust this folder')
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	try {
		expect(await host['namzu/conversations/archived']({})).toEqual([])
		await expect(host['namzu/conversations/unarchive']({ sessionId })).rejects.toThrow(
			'not archived',
		)
		await host['namzu/conversations/archive']({ sessionId })
		const archived = await host['namzu/conversations/archived']({})
		expect(archived).toHaveLength(1)
		expect(archived[0]).toMatchObject({ id: sessionId })
		expect(await host['namzu/conversations/list']()).toEqual([])
		const restored = await host['namzu/conversations/unarchive']({ sessionId })
		expect(restored).toMatchObject({ id: sessionId })
		expect(await host['namzu/conversations/archived']({})).toEqual([])
		expect(await host['namzu/conversations/list']()).toHaveLength(1)
		await expect(host['namzu/conversations/unarchive']({ sessionId })).rejects.toThrow(
			'not archived',
		)
		await expect(
			host['namzu/conversations/unarchive']({ sessionId: generateSessionId() }),
		).rejects.toThrow('does not belong')
		await expect(host['namzu/conversations/unarchive']({ sessionId, purge: true })).rejects.toThrow(
			'Invalid',
		)
		await expect(host['namzu/conversations/archived']({ extra: 1 })).rejects.toThrow('Invalid')
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('lists no archived conversations and refuses a restore in a Pal workspace', async () => {
	const pal = createPal({ name: 'Archive boundary fixture' })
	const owner = runtime()
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	const host = createDesktopHostExtensions(owner, pal.workspace)
	host['namzu/project/trust']({ confirmed: true, cwd: pal.workspace })
	try {
		expect(await host['namzu/conversations/archived']({})).toEqual([])
		await expect(host['namzu/conversations/unarchive']({ sessionId })).rejects.toThrow('Pal')
	} finally {
		await owner.close()
	}
})

it('refuses to restore a conversation whose log has no session header', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const sessionId = generateSessionId()
	try {
		await expect(host['namzu/conversations/unarchive']({ sessionId })).rejects.toThrow()
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('archives settled native history by releasing only its owning SDK harness writer', async () => {
	const base = runtime()
	const close = vi.fn(async () => ({ stopped: true as const }))
	const adapter: HarnessAdapter = {
		engineId: 'codex',
		profileRef: 'archive-native-fixture',
		open: async ({ cwd, model, resume }, emit) => {
			const binding = resume ?? {
				v: 1,
				engineId: 'codex',
				profileRef: 'archive-native-fixture',
				nativeSessionId: 'opaque-archive-native-session',
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
					reviewModes: ['prompt'],
				},
				models: async () => [{ id: 'native-fixture-model', label: 'Native fixture model' }],
				dispatch: async () => {
					const turn = { nativeSessionId: binding.nativeSessionId, nativeTurnId: 'archive-turn' }
					await emit({ kind: 'turn-started', ...turn })
					await emit({ kind: 'message-started', ...turn, nativeItemId: 'archive-answer' })
					await emit({
						kind: 'message-completed',
						...turn,
						nativeItemId: 'archive-answer',
						content: 'Preserved native answer',
						stopReason: 'end_turn',
					})
					await emit({
						kind: 'turn-completed',
						...turn,
						status: 'completed',
						finalItemId: 'archive-answer',
						result: 'Preserved native answer',
					})
					return turn
				},
				interrupt: async () => ({ requested: true }),
				respond: async () => ({ sent: true }),
				readHistory: async () => ({ binding, events: [], pendingReviews: [], complete: true }),
				close,
			}
		},
	}
	const owner = withCliHarnesses(base, cwd, {
		adapter: async () => adapter,
		models: async () => [{ id: 'native-fixture-model', label: 'Native fixture model' }],
		installed: async () => true,
	})
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const sessionId = generateSessionId()
	await owner.selectHarness(sessionId, 'codex-cli')
	await owner.gateway.prompt({
		sessionId,
		cwd,
		prompt: 'Native archived request',
		history: [],
		filesystem: undefined,
		signal: new AbortController().signal,
		onEvent: () => {},
		ask: async () => ({ kind: 'reject' }),
	})
	const state = await openSessions(cwd)
	const file = state.paths.sessionLog({ sessionId })
	const before = readFileSync(file, 'utf8')
	try {
		expect(
			await DiskSessionLog.at(state.paths, { sessionId }).claim({
				holder: 'competing-archive-fixture',
				ttlMs: 30_000,
			}),
		).toBeNull()
		expect(await host['namzu/conversations/archive']({ sessionId })).toEqual({
			sessionId,
			archived: true,
		})
		expect(close).toHaveBeenCalledOnce()
		expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true)
		expect((await sessionStorage.readConversationFacts(state, sessionId))?.archived).toBe(true)
		expect(
			withoutJournalMetadata((await host['namzu/conversations/history']({ sessionId })).messages),
		).toEqual([
			{ role: 'user', text: 'Native archived request' },
			{ role: 'assistant', text: 'Preserved native answer' },
		])
		expect(await host['namzu/conversations/list']()).toEqual([])
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('archives a claimed Pal through its original strict path without invoking native engines', async () => {
	const pal = createPal({ name: 'Archive ownership fixture' })
	const adapter = vi.fn(async () => {
		throw new Error('Pal archive must not construct a native engine')
	})
	const models = vi.fn(async () => {
		throw new Error('Pal archive must not discover native models')
	})
	const owner = withCliHarnesses(runtime(), pal.workspace, {
		adapter,
		models,
		installed: async () => false,
	})
	const host = createDesktopHostExtensions(owner, pal.workspace)
	const sessionId = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, sessionId)
	const state = await openSessions(pal.workspace)
	await recordTurn(state, sessionId, [
		createUserMessage('Retain this Pal conversation'),
		createAssistantMessage('The conversation will stay in history.'),
	])
	const file = state.paths.sessionLog({ sessionId })
	const before = readFileSync(file, 'utf8')
	try {
		expect(await host['namzu/conversations/archive']({ sessionId })).toEqual({
			sessionId,
			archived: true,
		})
		expect((await sessionStorage.readConversationFacts(state, sessionId))?.archived).toBe(true)
		expect(readFileSync(file, 'utf8').startsWith(before)).toBe(true)
		expect(
			withoutJournalMetadata((await host['namzu/conversations/history']({ sessionId })).messages),
		).toEqual([
			{ role: 'user', text: 'Retain this Pal conversation' },
			{ role: 'assistant', text: 'The conversation will stay in history.' },
		])
		expect(adapter).not.toHaveBeenCalled()
		expect(models).not.toHaveBeenCalled()
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('reports absent unsent history truthfully without creating a journal or preparing a runtime', async () => {
	const owner = runtime()
	const id = generateSessionId()
	const host = createDesktopHostExtensions(owner, cwd, (sessionId) =>
		sessionId === id ? cwd : undefined,
	)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const load = vi.spyOn(owner.gateway, 'load')
	const prepare = vi.spyOn(owner, 'providerStatus')
	try {
		expect(await host['namzu/conversations/archive']({ sessionId: id })).toEqual({
			sessionId: id,
			archived: false,
			missing: true,
		})
		expect(existsSync(state.paths.sessionLog({ sessionId: id }))).toBe(false)
		expect(load).not.toHaveBeenCalled()
		expect(prepare).not.toHaveBeenCalled()
		expect(await host['namzu/conversations/list']()).toEqual([])
		await expect(
			host['namzu/conversations/archive']({ sessionId: 'unowned-path' }),
		).rejects.toThrow('conversation id')
		await expect(
			host['namzu/conversations/archive']({ sessionId: id, purge: true }),
		).rejects.toThrow('archive request')
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it.each(['empty', ...(process.platform === 'win32' ? [] : ['dangling symlink'])])(
	'refuses an existing %s journal instead of claiming physical absence or repairing it',
	async (kind) => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const state = await openSessions(cwd)
		const sessionId = generateSessionId()
		const file = state.paths.sessionLog({ sessionId })
		mkdirSync(dirname(file), { recursive: true })
		if (kind === 'empty') writeFileSync(file, '')
		else symlinkSync(join(root, 'deliberately-absent-journal'), file)
		const original = lstatSync(file)
		try {
			await expect(host['namzu/conversations/archive']({ sessionId })).rejects.toThrow(
				'no verified session header',
			)
			const retained = lstatSync(file)
			expect(retained.ino).toBe(original.ino)
			expect(retained.size).toBe(original.size)
			expect(retained.isSymbolicLink()).toBe(kind !== 'empty')
			if (kind === 'empty') expect(readFileSync(file, 'utf8')).toBe('')
		} finally {
			closeSessions(state)
			await owner.close()
		}
	},
)

it.each(['projectId', 'tenantId'] as const)(
	'refuses archive when the real journal records another %s',
	async (field) => {
		const owner = runtime()
		const host = createDesktopHostExtensions(owner, cwd)
		host['namzu/project/trust']({ confirmed: true, cwd })
		const state = await openSessions(cwd)
		const sessionId = await startConversation(
			field === 'projectId'
				? { ...state, projectId: generateProjectId() }
				: { ...state, tenantId: generateTenantId() },
		)
		const before = readFileSync(state.paths.sessionLog({ sessionId }), 'utf8')
		try {
			await expect(host['namzu/conversations/archive']({ sessionId })).rejects.toThrow(
				'does not belong',
			)
			expect(readFileSync(state.paths.sessionLog({ sessionId }), 'utf8')).toBe(before)
		} finally {
			closeSessions(state)
			await owner.close()
		}
	},
)

it('refuses corrupt archive history and open parked turns without mutating either log', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const corruptId = await startConversation(state)
	const parkedId = await startConversation(state)
	await recordTurn(state, parkedId, [createUserMessage('Waiting for review')], { status: 'paused' })
	appendFileSync(state.paths.sessionLog({ sessionId: corruptId }), '{broken durable record}\n')
	try {
		for (const sessionId of [corruptId, parkedId]) {
			const before = readFileSync(state.paths.sessionLog({ sessionId }), 'utf8')
			await expect(host['namzu/conversations/archive']({ sessionId })).rejects.toThrow()
			expect(readFileSync(state.paths.sessionLog({ sessionId }), 'utf8')).toBe(before)
		}
		expect((await sessionStorage.readConversationFacts(state, parkedId))?.archived).toBe(false)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('requires idle known background jobs for both durable archive and missing receipts', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const missingId = generateSessionId()
	const jobs = vi.spyOn(owner, 'jobs')
	try {
		for (const unsafe of [
			[{ status: 'running' }],
			[{ status: 'exited', recoveryRequired: true }],
			undefined,
		]) {
			jobs.mockReturnValue(unsafe as unknown as readonly sdk.BackgroundJob[])
			await expect(host['namzu/conversations/archive']({ sessionId })).rejects.toThrow(
				'background work',
			)
			await expect(host['namzu/conversations/archive']({ sessionId: missingId })).rejects.toThrow(
				'background work',
			)
		}
		expect((await sessionStorage.readConversationFacts(state, sessionId))?.archived).toBe(false)
		expect(existsSync(state.paths.sessionLog({ sessionId: missingId }))).toBe(false)
	} finally {
		closeSessions(state)
		await owner.close()
	}
})

it('archives only the captured trusted home when indexed opening yields to an ambient home change', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	const replacementHome = join(root, 'replacement-archive-state')
	mkdirSync(replacementHome)
	const actualOpen = sessionStorage.openSessions
	vi.spyOn(sessionStorage, 'openSessions').mockImplementation(async (...args) => {
		const opened = await actualOpen(...args)
		vi.stubEnv('NAMZU_HOME', replacementHome)
		return opened
	})
	try {
		expect(await host['namzu/conversations/archive']({ sessionId })).toEqual({
			sessionId,
			archived: true,
		})
		expect((await sessionStorage.readConversationFacts(state, sessionId))?.archived).toBe(true)
	} finally {
		vi.stubEnv('NAMZU_HOME', state.root)
		closeSessions(state)
		await owner.close()
	}
})

it('keeps idempotent archive retries behind an existing writer lease', async () => {
	const owner = runtime()
	const host = createDesktopHostExtensions(owner, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const { state, sessionId } = await seeded()
	await archiveConversation(state, sessionId)
	const log = DiskSessionLog.at(state.paths, { sessionId })
	const held = await log.claim({ holder: 'fixture-writer', ttlMs: 30_000 })
	expect(held).not.toBeNull()
	let attempted!: () => void
	const blocked = new Promise<void>((resolve) => {
		attempted = resolve
	})
	const claim = DiskSessionLog.prototype.claim
	vi.spyOn(DiskSessionLog.prototype, 'claim').mockImplementation(async function (
		this: DiskSessionLog,
		request,
	) {
		const result = await claim.call(this, request)
		if (this.sessionId === sessionId && !result) attempted()
		return result
	})
	vi.useFakeTimers()
	try {
		const rejected = expect(host['namzu/conversations/archive']({ sessionId })).rejects.toThrow(
			'another writer holds',
		)
		await blocked
		await vi.advanceTimersByTimeAsync(5_000)
		await rejected
		expect((await sessionStorage.readConversationFacts(state, sessionId))?.archived).toBe(true)
	} finally {
		vi.useRealTimers()
		await log.release(held!)
		closeSessions(state)
		await owner.close()
	}
})
