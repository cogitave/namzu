import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DiskMemoryStore, SearchToolsTool, createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import * as mcp from '../../integrations/mcp/servers.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { compilePermissions } from '../../permissions/rules.js'
import { type AgentEvent, type AgentSessionOptions, createAgentSession } from '../agent.js'

interface Request {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
	readonly tools: readonly { readonly function: { readonly name: string } }[]
}

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'deepseek' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.deepseek,
		source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]
const core = ['bash', 'edit', 'glob', 'grep', 'job', 'read', 'write', 'web_search', 'web_fetch']
const save = {
	title: 'Fixture fact',
	summary: 'Exact evidence',
	content: 'Retained fixture evidence',
}
let cwd: string
let requests: Request[]

function response(tool?: { readonly name: string; readonly input: unknown }): Response {
	const chunk = {
		id: 'chatcmpl-deferred-fixture',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'deepseek-chat',
		choices: [
			{
				index: 0,
				delta: tool
					? {
							tool_calls: [
								{
									index: 0,
									id: `call_${requests.length}`,
									type: 'function',
									function: { name: tool.name, arguments: JSON.stringify(tool.input) },
								},
							],
						}
					: { content: 'Done.' },
				finish_reason: tool ? 'tool_calls' : 'stop',
			},
		],
		usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
	}
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

function mockProvider(next: (request: Request, index: number) => Response): void {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			const request = JSON.parse(String(init?.body)) as Request
			requests.push(request)
			return next(request, requests.length - 1)
		}),
	)
}

async function open(options: AgentSessionOptions = {}) {
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		web: { search: 'live', fetch: true },
		memory: { recall: false },
		limits: { maxIterations: 4 },
		...options,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	return session
}

function names(request: Request): string[] {
	return request.tools.map((tool) => tool.function.name).sort()
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-session-tool-loading-'))
	requests = []
	await mkdir(join(cwd, '.namzu'))
	await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_INSTRUCTION_MUST_REMAIN: work carefully.')
	await writeFile(join(cwd, '.namzu', 'MEMORY.md'), 'CURATED_MEMORY_MUST_REMAIN: fixture evidence.')
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('explicit tool loading reaches the real session and query', () => {
	it.each([undefined, 'eager'] as const)(
		'retains existing eager schemas for %s',
		async (toolLoading) => {
			mockProvider(() => response())
			const session = await open({ ...(toolLoading ? { toolLoading } : {}) })
			try {
				for await (const _ of session.send([createUserMessage('Inspect the fixture')])) {
					// Drain the real query through the fake provider transport.
				}
				expect(requests).toHaveLength(1)
				expect(names(requests[0])).toEqual(
					expect.arrayContaining([...core, 'Agent', 'save_memory', 'task_create', 'task_list']),
				)
				expect(names(requests[0])).not.toContain('search_tools')
				expect(names(requests[0])).toHaveLength(23)
				expect(JSON.stringify(requests[0].messages)).not.toContain(
					'Before using a tool listed under',
				)
			} finally {
				await session.close()
			}
		},
	)

	it('does not require optional web tools when selecting the eager core', async () => {
		mockProvider(() => response())
		const session = await open({ toolLoading: 'deferred', web: { search: 'off' } })
		try {
			for await (const _ of session.send([createUserMessage('Inspect the fixture')])) {
				// No network capability is configured for this send.
			}
			expect(requests).toHaveLength(1)
			expect(names(requests[0])).toEqual([
				'bash',
				'edit',
				'glob',
				'grep',
				'job',
				'read',
				'search_tools',
				'write',
			])
		} finally {
			await session.close()
		}
	})

	it('loads the requested runtime task tool and resets activation for the next send', async () => {
		mockProvider((_request, index) => {
			if (index % 3 === 0)
				return response({ name: 'search_tools', input: { query: 'task_create' } })
			if (index % 3 === 1)
				return response({ name: 'task_create', input: { subject: 'Check fixture evidence' } })
			return response()
		})
		const session = await open({ toolLoading: 'deferred' })
		const initialSessionTools = session.toolNames()
		try {
			for (let turn = 0; turn < 2; turn++) {
				const events: AgentEvent[] = []
				for await (const event of session.send([createUserMessage('Track the fixture check')], {
					permissionMode: 'plan',
					extraSystem: 'RESIDENT_CONTINUITY_MUST_REMAIN: earlier saved summary.',
				}))
					events.push(event)
				expect(events.at(-1), JSON.stringify(events)).toMatchObject({
					kind: 'done',
					stopReason: 'end_turn',
				})
				expect(requests).toHaveLength((turn + 1) * 3)
				const [first, second, third] = requests.slice(turn * 3, turn * 3 + 3)
				expect(names(first)).toEqual([...core, 'search_tools'].sort())
				expect(names(second)).toContain('task_create')
				expect(names(third)).toContain('task_create')
				expect(JSON.stringify(third.messages)).toContain('Task created:')
				const prompt = JSON.stringify(first.messages)
				for (const retained of [
					'PROJECT_INSTRUCTION_MUST_REMAIN',
					'CURATED_MEMORY_MUST_REMAIN',
					'RESIDENT_CONTINUITY_MUST_REMAIN',
					'## How you work',
					'### Planning and delegating',
					'## Plan mode',
					'## Environment',
					cwd,
					'<deferred_tools>',
					'Agent',
					'save_memory',
					'Before using a tool listed under deferred_tools',
				])
					expect(prompt).toContain(retained)
				// A send's runtime tools and activation never mutate the source registry.
				expect(session.toolNames()).toEqual(initialSessionTools)
			}
		} finally {
			await session.close()
		}
	})

	it('keeps discovery callable when the session already owns an active search_tools', async () => {
		// Supply an existing discovery definition at the session's tool boundary.
		// query only mounts discovery when absent, so deferring this entry strands it.
		vi.spyOn(mcp, 'connectMcpServers').mockResolvedValue({
			tools: [SearchToolsTool],
			connected: [],
			failed: [],
			current: () => ({ connected: [], failed: [] }),
			close: async () => {},
		})
		mockProvider((_request, index) =>
			index === 0 ? response({ name: 'search_tools', input: { query: 'task_list' } }) : response(),
		)
		const session = await open({ toolLoading: 'deferred' })
		try {
			for await (const _ of session.send([createUserMessage('Find the planning list')])) {
				// Drain the discovery result and the next provider request.
			}
			expect(requests).toHaveLength(2)
			expect(names(requests[0])).toContain('search_tools')
			expect(names(requests[0])).not.toContain('task_list')
			expect(names(requests[1])).toContain('task_list')
		} finally {
			await session.close()
		}
	})

	it.each(['plan', 'strict', 'explicit deny', 'explicit allow'] as const)(
		'keeps %s permission enforcement after a memory tool is loaded',
		async (policy) => {
			mockProvider((_request, index) => {
				if (index === 0) return response({ name: 'search_tools', input: { query: 'save_memory' } })
				if (index === 1) return response({ name: 'save_memory', input: save })
				return response()
			})
			const session = await open({
				toolLoading: 'deferred',
				...(policy === 'explicit deny' || policy === 'explicit allow'
					? {
							rules: compilePermissions({
								save_memory: policy === 'explicit deny' ? 'deny' : 'allow',
							}).rules,
						}
					: {}),
			})
			try {
				const events: AgentEvent[] = []
				for await (const event of session.send([createUserMessage('Store the fixture fact')], {
					permissionMode: policy === 'plan' || policy === 'strict' ? policy : 'auto',
				}))
					events.push(event)
				expect(requests, JSON.stringify(events)).toHaveLength(3)
				expect(names(requests[0])).not.toContain('save_memory')
				expect(names(requests[1])).toContain('save_memory')
				// With no stateRoot option the session's projectStateRoot is cwd/.namzu.
				// The positive allow case proves this is the store the tool actually uses.
				const memories = await new DiskMemoryStore({ baseDir: join(cwd, '.namzu') }).list()
				if (policy === 'explicit allow') {
					expect(JSON.stringify(requests[2].messages)).toContain('Memory saved:')
					expect(memories.totalCount).toBe(1)
					expect(memories.entries[0]).toMatchObject({ title: save.title, summary: save.summary })
				} else {
					expect(JSON.stringify(requests[2].messages)).toMatch(/refus|denied/i)
					expect(JSON.stringify(requests[2].messages)).not.toContain('Memory saved:')
					expect(memories).toEqual({ entries: [], totalCount: 0 })
				}
			} finally {
				await session.close()
			}
		},
	)
})
