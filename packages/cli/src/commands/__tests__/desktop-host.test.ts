import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	ACPServer,
	DiskSessionLog,
	HostCommandRegistry,
	type MCPJsonRpcMessage,
	type MCPTransport,
	MockLLMProvider,
	ToolManager,
	asSessionId,
	createToolPresenter,
	createUserMessage,
	drainQuery,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixtureUuid } from '../../../../sdk/src/test-support/ids.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/registry.js'
import {
	archiveConversation,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { getPalRevision, listPals } from '../../pals/store.js'
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
	vi.unstubAllEnvs()
	removeTempDir(root)
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
async function seeded(prompt = 'Stored request') {
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
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
	expect(() => host['namzu/project/trust']({ confirmed: true, cwd: root })).toThrow(
		'does not match',
	)
	expect(host['namzu/project/trust']({ confirmed: true, cwd })).toMatchObject({
		trusted: true,
	})
	expect(await host['namzu/conversations/list']()).toEqual([])
	await owner.close()
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
		{ config: {}, formatter: { name: 'text', print: () => {}, info: () => {}, error: () => {} } },
		{
			probe: async () => ({
				preferences: { version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
				detected: [{ entry: PROVIDER_REGISTRY.zen, source: { kind: 'public' }, alternatives: [] }],
				needsRepickReason: null,
				credentialGap: { providerId: 'anthropic', reason: 'Fixture missing provider.' },
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
			).toMatchObject({ error: { message: 'This conversation does not belong to this project.' } })
		await server.stop()
		await expect(host['namzu/providers/status']({ sessionId })).rejects.toThrow('does not belong')
	} finally {
		await server.stop()
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
