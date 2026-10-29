import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { loadConfigWithProvenance } from '../../config/load.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { createLivePermissionRules } from '../../permissions/live-rules.js'
import { addLocalRule, removeLocalRule } from '../../permissions/rule-screen.js'
import { permissionLayersOf } from '../../permissions/rules.js'
import { type AgentEvent, createAgentSession } from '../agent.js'

let cwd: string
let request = 0
function response(forceTool?: boolean) {
	const tool = forceTool ?? request % 2 === 0
	request++
	const delta = tool
		? {
				tool_calls: [
					{
						index: 0,
						id: `call_${request}`,
						type: 'function',
						function: {
							name: 'write',
							arguments: JSON.stringify({ path: join(cwd, 'result.txt'), content: 'saved' }),
						},
					},
				],
			}
		: { content: 'Done.' }
	return new Response(
		`data: ${JSON.stringify({ id: `reply_${request}`, object: 'chat.completion.chunk', created: 1, model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\ndata: [DONE]\n\n`,
		{ headers: { 'content-type': 'text/event-stream' } },
	)
}
afterEach(() => {
	vi.unstubAllGlobals()
	if (cwd) removeTempDir(cwd)
})
it('removes a launch-time local deny for later calls without restarting the real session, then live deny blocks execution', async () => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-session-permission-edit-'))
	request = 0
	writeFileSync(
		join(cwd, 'namzu.config.local.json'),
		JSON.stringify({ permissions: { write: 'deny' } }),
	)
	const { config } = loadConfigWithProvenance({
		cwd,
		home: cwd,
		env: {},
		managedPath: join(cwd, 'managed.json'),
	})
	const live = createLivePermissionRules({ cwd, layers: permissionLayersOf(config) })
	let nextReply = () => response()
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => nextReply()),
	)
	const session = await createAgentSession(
		{ version: 3, providers: [{ id: 'deepseek' }], subagents: { active: [] } },
		[
			{
				entry: PROVIDER_REGISTRY.deepseek,
				source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
				apiKey: 'fixture-only',
				alternatives: [],
			},
		],
		{
			cwd,
			rules: live.rules,
			reloadPermissionRules: live.reload,
			sandbox: { enabled: false },
			plugins: { enabled: false },
			memory: { recall: false },
			limits: { maxIterations: 4 },
		},
	)
	let asks = 0
	const run = async () => {
		const events: AgentEvent[] = []
		for await (const event of session.send([createUserMessage('Write the result.')], {
			permissionMode: 'prompt',
			onPermission: async () => {
				asks++
				return { kind: 'approve' }
			},
		}))
			events.push(event)
		expect(events.at(-1)?.kind, JSON.stringify(events)).toBe('done')
		return events
	}
	try {
		expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
		await run()
		expect(existsSync(join(cwd, 'result.txt'))).toBe(false)
		expect(asks).toBe(0)
		removeLocalRule(cwd, 'Write')
		session.reloadPermissionRules?.()
		await run()
		expect(asks).toBe(1)
		expect(readFileSync(join(cwd, 'result.txt'), 'utf8')).toBe('saved')
		addLocalRule(cwd, 'deny', 'Write')
		session.reloadPermissionRules?.()
		await run()
		expect(asks).toBe(1)
		// This time the editor runs between two provider requests of ONE turn.
		// The first write stays denied. The later batch uses the same captured
		// gate predicates, sees the removal, and asks rather than replaying it.
		request = 0
		nextReply = () => {
			if (request === 1) {
				removeLocalRule(cwd, 'Write')
				session.reloadPermissionRules?.()
			}
			return response(request < 2)
		}
		const liveEvents = await run()
		expect(asks, JSON.stringify(liveEvents)).toBe(2)
	} finally {
		await session.close()
	}
})
