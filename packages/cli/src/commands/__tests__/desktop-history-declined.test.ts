import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionLog,
	MockLLMProvider,
	type ResumeHandler,
	type ToolDefinition,
	drainQuery,
	toolset,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
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
	root = mkdtempSync(join(tmpdir(), 'namzu-history-work-'))
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
async function fixture() {
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
	const host = createDesktopHostExtensions(runtime, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	const log = DiskSessionLog.at(state.paths, { sessionId })
	return {
		state,
		sessionId,
		log,
		history: () => host['namzu/conversations/history']({ sessionId }),
		close: async () => {
			closeSessions(state)
			await runtime.close()
		},
	}
}
const anyInput = { safeParse: (value: unknown) => ({ success: true, data: value }) } as never

const edit = (run: () => void): ToolDefinition => ({
	name: 'edit',
	description: 'Replace text in a file.',
	inputSchema: anyInput,
	modelInputSchema: { type: 'object', properties: {} },
	category: 'custom',
	permissions: [],
	isReadOnly: () => false,
	isDestructive: () => true,
	isConcurrencySafe: () => false,
	presentCall: (input) => {
		const call = input as { path: string; old_string: string; new_string: string }
		return { kind: 'diff', path: call.path, before: call.old_string, after: call.new_string }
	},
	async execute() {
		run()
		return { success: true, output: 'edited' }
	},
})

/** A real turn through the kernel, answered at review the way the host answers it. */
async function runTurn(
	f: Awaited<ReturnType<typeof fixture>>,
	resumeHandler: ResumeHandler,
	ran: () => void,
) {
	await drainQuery({
		provider: new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							id: 'call_edit',
							name: 'edit',
							args: { path: '/repo/src/app.css', old_string: 'a', new_string: 'b' },
						},
					],
				},
				{ text: 'Understood.' },
			],
		}),
		toolsets: [toolset('fixture', [edit(ran)])],
		resumeHandler,
		sessionLog: f.log,
		agentId: 'declined-agent',
		agentName: 'Declined',
		messages: [{ role: 'user', content: 'Change the colour.' }],
		workingDirectory: cwd,
		turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 5_000, maxIterations: 4 },
		projectId: f.state.projectId,
		sessionId: f.sessionId,
		topicId: f.state.topicId,
		tenantId: f.state.tenantId,
	})
	return f.history()
}

it('replays a declined change with the person’s note after the conversation is reopened', async () => {
	const f = await fixture()
	try {
		const ran = vi.fn()
		const note = 'Keep the old colour; "brand" is not final.'
		const result = await runTurn(
			f,
			async () => ({
				action: 'reject_tools',
				feedback: `The user declined this change and said: ${note}`,
				declined: { note },
			}),
			ran,
		)
		expect(ran).not.toHaveBeenCalled()
		expect(result.work?.tools).toMatchObject([
			{
				toolUseId: 'call_edit',
				name: 'edit',
				status: 'failed',
				presentation: {
					kind: 'generic',
					label: '/repo/src/app.css',
					declined: { note },
				},
			},
		])
		expect(result.work?.tools[0]?.detailUnavailable).toBeUndefined()
		expect(result.work?.partial).toBe(false)
	} finally {
		await f.close()
	}
})

it('replays a refusal by policy exactly as before: failed, with no recorded presentation', async () => {
	const f = await fixture()
	try {
		const ran = vi.fn()
		const result = await runTurn(
			f,
			async () => ({ action: 'reject_tools', feedback: 'Strict mode does not run edits.' }),
			ran,
		)
		expect(ran).not.toHaveBeenCalled()
		const [tool] = result.work?.tools ?? []
		expect(tool).toMatchObject({
			toolUseId: 'call_edit',
			status: 'failed',
			detailUnavailable: true,
		})
		expect(tool?.presentation).toBeUndefined()
		expect(result.work?.partial).toBe(true)
	} finally {
		await f.close()
	}
})
