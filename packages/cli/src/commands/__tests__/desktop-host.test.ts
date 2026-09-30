import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskSessionLog, MockLLMProvider, createUserMessage, drainQuery } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	archiveConversation,
	closeSessions,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
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
