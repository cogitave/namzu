import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	DiskMemoryStore,
	DiskResidentAgenda,
	ResidentHost,
	type ResidentPursuitStep,
	type ResidentState,
	createUserMessage,
	generateTenantId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
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
const OBJECTIVE = 'Check both authorized fixture revisions and retain the evidence.'
const OUTPUT = 'HOST_OUTPUT_CONTRACT: return a disposition and a saved evidence summary.'
let cwd: string
let requests: Request[]

function response(tool?: { readonly name: string; readonly input: unknown }): Response {
	const chunk = {
		id: 'chatcmpl-resident-context-fixture',
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
					: { content: 'The permitted fixture check is finished.' },
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

function mockProvider(next: (index: number) => Response): void {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Request)
			return next(requests.length - 1)
		}),
	)
}

async function open(options: AgentSessionOptions = {}) {
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		web: { search: 'off' },
		memory: { recall: false },
		limits: { maxIterations: 5 },
		...options,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	return session
}

function system(request: Request): string[] {
	return request.messages
		.filter((message) => message.role === 'system')
		.map((message) => String(message.content))
}

async function agendaFixture() {
	const root = join(cwd, '.namzu', 'resident-fixture')
	const scope = { tenantId: generateTenantId(), agentKey: 'fixture-reviewer' }
	const agenda = new DiskResidentAgenda(root, scope)
	const initial = await agenda.create('A careful repository reviewer.')
	const pursuit = await agenda.add(initial, OBJECTIVE)
	return { agenda, pursuit, reopen: () => new DiskResidentAgenda(root, scope) }
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-session-resident-context-'))
	requests = []
	await mkdir(join(cwd, '.namzu'))
	await writeFile(join(cwd, 'AGENTS.md'), 'PROJECT_POLICY: preserve both acceptance criteria.')
	await writeFile(join(cwd, '.namzu', 'MEMORY.md'), 'CURATED_VERSION_ONE: first fixture context.')
	await writeFile(join(cwd, 'evidence.txt'), 'FILE_VERSION_ONE: alpha-471\n')
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('resident context reaches real CLI sessions', () => {
	it('retains fresh admission context through both read loops with one stable policy prefix', async () => {
		mockProvider((index) =>
			index % 2 === 0 ? response({ name: 'read', input: { path: 'evidence.txt' } }) : response(),
		)
		const fixture = await agendaFixture()
		const admitted: ResidentState[] = []
		const step: ResidentPursuitStep = async ({ state }, signal) => {
			admitted.push(state)
			const session = await open({ toolLoading: 'deferred', permissionMode: 'plan' })
			try {
				const events: AgentEvent[] = []
				for await (const event of session.send(
					[createUserMessage('Continue the fixture review.')],
					{
						signal,
						permissionMode: 'plan',
						residentContext: {
							state,
							readOnly: true,
							skillsContext: 'HOST_SKILL: preserve exact receipt identifiers.',
							outputInstructions: OUTPUT,
						},
					},
				))
					events.push(event)
				expect(events.at(-1), JSON.stringify(events)).toMatchObject({
					kind: 'done',
					stopReason: 'end_turn',
				})
				const finalRequest = requests.at(-1)
				expect(JSON.stringify(finalRequest?.messages)).toContain(
					state.stepsAdmitted === 1 ? 'FILE_VERSION_ONE' : 'FILE_VERSION_TWO',
				)
			} finally {
				await session.close()
			}
			return state.stepsAdmitted === 1
				? {
						kind: 'wait',
						wakeAt: null,
						summary: 'SAVED_AFTER_FIRST: check the second revision next.',
					}
				: { kind: 'complete', summary: 'SAVED_AFTER_SECOND: both authorized revisions were read.' }
		}
		const firstHost = new ResidentHost(fixture.agenda, step)
		await firstHost.wake(fixture.pursuit.id, 'FIRST_WAKE: the initial receipt is ready.')
		expect(
			await firstHost.run({ signal: new AbortController().signal, maxSteps: 1 }),
		).toMatchObject({
			status: 'limit',
			stepsSettled: 1,
		})
		expect(await fixture.reopen().execution(fixture.pursuit.id).read()).toMatchObject({
			phase: 'waiting',
			stepsAdmitted: 1,
			summary: 'SAVED_AFTER_FIRST: check the second revision next.',
		})

		await writeFile(join(cwd, 'evidence.txt'), 'FILE_VERSION_TWO: beta-822\n')
		await writeFile(
			join(cwd, '.namzu', 'MEMORY.md'),
			'CURATED_VERSION_TWO: revised fixture context.',
		)
		const resumedHost = new ResidentHost(fixture.reopen(), step)
		await resumedHost.wake(fixture.pursuit.id, 'SECOND_WAKE: the revised receipt is ready.')
		expect(
			await resumedHost.run({ signal: new AbortController().signal, maxSteps: 1 }),
		).toMatchObject({
			status: 'limit',
			stepsSettled: 1,
		})

		expect(admitted).toHaveLength(2)
		expect(requests).toHaveLength(4)
		const prefix = system(requests[0])[0]
		expect(prefix).toContain(OUTPUT)
		expect(prefix).not.toContain(OBJECTIVE)
		expect(prefix).not.toContain('CURATED_VERSION_')
		expect(prefix).not.toContain('HOST_SKILL')
		expect(prefix).not.toContain('Then stop and wait')
		for (const [index, request] of requests.entries()) {
			const admission = index < 2 ? 0 : 1
			const state = admitted[admission]
			const [currentPrefix, dynamic] = system(request)
			expect(currentPrefix).toBe(prefix)
			expect(dynamic).toContain(OBJECTIVE)
			expect(dynamic).toContain(state.identity)
			expect(dynamic).toContain(state.reason)
			expect(dynamic).toContain('HOST_SKILL')
			expect(dynamic).toContain(admission === 0 ? 'CURATED_VERSION_ONE' : 'CURATED_VERSION_TWO')
			expect(dynamic).not.toContain(admission === 0 ? 'CURATED_VERSION_TWO' : 'CURATED_VERSION_ONE')
			if (state.summary) expect(dynamic).toContain(state.summary)
			expect(JSON.stringify(request.messages)).toContain('PROJECT_POLICY')
		}
		expect(admitted[0].summary).toBeNull()
		expect(admitted[1].summary).toBe('SAVED_AFTER_FIRST: check the second revision next.')
		expect(JSON.stringify(requests[3].messages)).not.toContain('FILE_VERSION_ONE')
		expect(await fixture.reopen().execution(fixture.pursuit.id).read()).toMatchObject({
			phase: 'complete',
			stepsAdmitted: 2,
			summary: 'SAVED_AFTER_SECOND: both authorized revisions were read.',
		})
	})

	it('keeps ordinary interactive guidance when no resident context is supplied', async () => {
		mockProvider(() => response())
		const session = await open({ toolLoading: 'deferred' })
		try {
			for await (const _ of session.send([createUserMessage('Inspect this project.')], {
				permissionMode: 'plan',
				extraSystem: 'INTERACTIVE_EXTRA_CONTEXT: current operator request.',
			})) {
				// Drain the ordinary production send without resident options.
			}
			expect(requests).toHaveLength(1)
			const prompt = system(requests[0]).join('\n')
			for (const retained of [
				'## How you work',
				'### Planning and delegating',
				'## Plan mode',
				'## Environment',
				'CURATED_VERSION_ONE',
				'INTERACTIVE_EXTRA_CONTEXT',
			])
				expect(prompt).toContain(retained)
			expect(prompt).not.toContain('## Resident continuation')
			expect(prompt).not.toContain(OUTPUT)
			expect(JSON.stringify(requests[0].messages)).toContain('PROJECT_POLICY')
		} finally {
			await session.close()
		}
	})

	it('refuses a discovered memory write in plan mode while a permitted read succeeds', async () => {
		mockProvider((index) => {
			if (index === 0) return response({ name: 'search_tools', input: { query: 'save_memory' } })
			if (index === 1)
				return response({
					name: 'save_memory',
					input: {
						title: 'Forbidden memory',
						summary: 'Must not save',
						content: 'UNAUTHORIZED_FACT',
					},
				})
			if (index === 2) return response({ name: 'read', input: { path: 'evidence.txt' } })
			return response()
		})
		const fixture = await agendaFixture()
		const admitted = await fixture.agenda
			.execution(fixture.pursuit.id)
			.claim(fixture.pursuit.state, Date.now())
		const session = await open({ toolLoading: 'deferred' })
		try {
			const events: AgentEvent[] = []
			for await (const event of session.send(
				[createUserMessage('Inspect the authorized evidence.')],
				{
					permissionMode: 'plan',
					residentContext: { state: admitted, outputInstructions: OUTPUT },
				},
			))
				events.push(event)
			expect(events.at(-1), JSON.stringify(events)).toMatchObject({
				kind: 'done',
				stopReason: 'end_turn',
			})
			expect(requests).toHaveLength(4)
			expect(requests[0].tools.map((tool) => tool.function.name)).not.toContain('save_memory')
			expect(requests[1].tools.map((tool) => tool.function.name)).toContain('save_memory')
			const afterRefusal = requests[2].messages.filter((message) => message.role === 'tool')
			expect(JSON.stringify(afterRefusal)).toMatch(/refus|denied/i)
			expect(JSON.stringify(afterRefusal)).not.toContain('Memory saved:')
			expect(JSON.stringify(requests[3].messages)).toContain('FILE_VERSION_ONE')
			for (const request of requests) {
				expect(system(request)[0]).toContain('## Read-only invocation')
				expect(system(request)[0]).toContain(OUTPUT)
				expect(system(request)[1]).toContain(OBJECTIVE)
			}
			// This is the default session tool store, distinct from curated MEMORY.md.
			expect(await new DiskMemoryStore({ baseDir: join(cwd, '.namzu') }).list()).toEqual({
				entries: [],
				totalCount: 0,
			})
			expect(await readFile(join(cwd, 'evidence.txt'), 'utf8')).toBe(
				'FILE_VERSION_ONE: alpha-471\n',
			)
			expect(await readFile(join(cwd, '.namzu', 'MEMORY.md'), 'utf8')).toContain(
				'CURATED_VERSION_ONE',
			)
		} finally {
			await session.close()
		}
	})
})
