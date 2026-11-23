/**
 * A workflow run outlives the turn that started it. The person refusing a call
 * (which stops that turn) is not the person stopping the run: the run goes on,
 * its end is reported, and a later "continue" reaches a model that is told
 * about the run, with a resume that reuses the agents that finished.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type AgentSessionOptions, type SendOptions, createAgentSession } from '../agent.js'

interface Request {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
	readonly tools?: readonly { readonly function: { readonly name: string } }[]
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
const SCRIPT = `export const meta = { name: 'two-step', description: 'One, then two', phases: [{ title: 'Go' }] }
const first = await agent('STEP-ONE', { label: 'first', phase: 'Go' })
const second = await agent('STEP-TWO', { label: 'second', phase: 'Go' })
return [first, second]`

let cwd: string
let requests: Request[]

function chunkResponse(
	text: string | undefined,
	tool?: { readonly name: string; readonly input: unknown },
): Response {
	const chunk = {
		id: 'chatcmpl-wf-continuity',
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
					: { content: text ?? 'Done.' },
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

function provider(next: (request: Request) => Promise<Response>) {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			const request = JSON.parse(String(init?.body)) as Request
			requests.push(request)
			return next(request)
		}),
	)
}

async function open(options: AgentSessionOptions = {}) {
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		memory: { recall: false },
		limits: { maxIterations: 6 },
		...options,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	return session
}

const isMain = (request: Request): boolean =>
	(request.tools ?? []).some((t) => t.function.name === 'stop_task')
const bodyOf = (request: Request): string => JSON.stringify(request.messages)
function lastReal(request: Request): string {
	for (const message of [...request.messages].reverse()) {
		const text = JSON.stringify(message)
		if (
			message.role === 'tool' ||
			(message.role === 'user' &&
				!text.includes('system-reminder') &&
				!text.includes('Current step context'))
		)
			return text
	}
	return ''
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-wf-continuity-'))
	requests = []
	await mkdir(join(cwd, '.namzu'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('a refused call that stops the turn', () => {
	it('leaves the background workflow run going and reports its end', async () => {
		let releaseFirst: () => void = () => {}
		const firstMayAnswer = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		let mainCalls = 0
		provider(async (request) => {
			if (!isMain(request)) {
				const step = /STEP-(ONE|TWO)/.exec(bodyOf(request))?.[0]
				if (step === 'STEP-ONE') await firstMayAnswer
				return chunkResponse(`answer ${step}`)
			}
			mainCalls += 1
			if (mainCalls === 1)
				return chunkResponse(undefined, { name: 'workflow', input: { script: SCRIPT } })
			if (mainCalls === 2)
				return chunkResponse(undefined, { name: 'bash', input: { command: 'touch refused.txt' } })
			return chunkResponse('Understood.')
		})
		const session = await open()
		const ends: string[] = []
		session.workflows?.onEnd((end) => ends.push(`${end.view.runId}:${end.view.status}`))
		try {
			for await (const _ of session.send([createUserMessage('go')], {
				workflowReview: {
					onPermission: async () => ({ kind: 'approve' }),
					currentPermissionMode: () => 'prompt',
				},
				onPermission: async (call) =>
					call.toolCalls.some((c) => c.name === 'bash')
						? { kind: 'reject', declined: {}, endTurn: true }
						: { kind: 'approve' },
				hypermode: true,
				permissionMode: 'prompt',
			} as SendOptions)) {
				// drain
			}
			// The refusal stopped the turn: nothing asked the model again, and the call did not run.
			expect(mainCalls).toBe(2)
			expect(existsSync(join(cwd, 'refused.txt'))).toBe(false)
			const [run] = session.workflows?.runs() ?? []
			expect(run?.status).toBe('running')
			releaseFirst()
			await session.workflows?.idle()
			expect(session.workflows?.runs()[0]?.status).toBe('completed')
			expect(ends).toEqual([`${run?.runId}:completed`])
		} finally {
			await session.close()
		}
	})
})

describe('"continue" after a run was stopped unfinished', () => {
	it('reaches a model that is told to resume it, and the resume reuses the finished agent', async () => {
		let holdSecond = true
		const answered: string[] = []
		let resumeRunId = ''
		let phase: 'start' | 'continue' = 'start'
		const mainRequests: Request[] = []
		provider(async (request) => {
			if (!isMain(request)) {
				const step = /STEP-(ONE|TWO)/.exec(bodyOf(request))?.[0] ?? 'unknown'
				answered.push(step)
				if (step === 'STEP-TWO' && holdSecond) await new Promise<never>(() => {})
				return chunkResponse(`answer ${step}`)
			}
			mainRequests.push(request)
			if (phase === 'start') {
				if (mainRequests.length === 1)
					return chunkResponse(undefined, { name: 'workflow', input: { script: SCRIPT } })
				return chunkResponse('Running.')
			}
			// The person said to continue: resume the run that was stopped.
			if (
				/resumeFromRunId/.test(lastReal(request)) ||
				/started in the background/.test(lastReal(request))
			)
				return chunkResponse('Resumed it.')
			return chunkResponse(undefined, {
				name: 'workflow',
				input: { script: SCRIPT, resumeFromRunId: resumeRunId },
			})
		})
		const session = await open()
		const send = async (text: string) => {
			for await (const _ of session.send([createUserMessage(text)], {
				workflowReview: {
					onPermission: async () => ({ kind: 'approve' }),
					currentPermissionMode: () => 'prompt',
				},
				hypermode: true,
			})) {
				// drain
			}
		}
		try {
			await send('go')
			const workflows = session.workflows
			const [run] = workflows?.runs() ?? []
			resumeRunId = run?.runId ?? ''
			// STEP-ONE finished and was saved; STEP-TWO is in flight.
			while (!answered.includes('STEP-TWO'))
				await new Promise<void>((resolve) => setImmediate(resolve))
			expect(workflows?.stop(resumeRunId)).toBe(true)
			await workflows?.idle()
			expect(workflows?.runs()[0]?.status).toBe('stopped')

			phase = 'continue'
			holdSecond = false
			const before = answered.length
			await send('Devam et')
			await workflows?.idle()
			// The model reading the request was told how to continue, in the tool it calls.
			const tools = JSON.stringify(mainRequests.at(-2)?.tools ?? mainRequests.at(-1)?.tools)
			expect(tools).toContain('resume it with workflow and resumeFromRunId')
			expect(answered.slice(before)).toEqual(['STEP-TWO'])
			expect(workflows?.runs().find((r) => r.runId === resumeRunId)?.status).toBe('completed')
		} finally {
			await session.close()
		}
	})
})
