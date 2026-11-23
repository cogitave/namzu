/**
 * `stop_task` through the real session and kernel, with a scripted provider
 * behind the transport: it is in the always-loaded list of a default turn and
 * a hypermode turn, `cancel_agent` is gone, the stop guidance reaches the
 * model, and a model that calls it on a live workflow run ends that run.
 */

import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAssistantMessage, createToolMessage, createUserMessage } from '@namzu/sdk'
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
const REVIEWER: NonNullable<SendOptions['workflowReview']> = {
	onPermission: async () => ({ kind: 'approve' }),
	currentPermissionMode: () => 'prompt',
}

let cwd: string
let requests: Request[]

function chunkResponse(
	text: string | undefined,
	tool?: { readonly name: string; readonly input: unknown },
): Response {
	const chunk = {
		id: 'chatcmpl-stop-task',
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

function provider(next: (request: Request, signal: AbortSignal | undefined) => Promise<Response>) {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			const request = JSON.parse(String(init?.body)) as Request
			requests.push(request)
			return next(request, init?.signal ?? undefined)
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

const toolNames = (request: Request): string[] => (request.tools ?? []).map((t) => t.function.name)
/** The latest message that is a tool result or something the person typed, not a runtime note. */
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
const bodyOf = (request: Request): string => JSON.stringify(request.messages)

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-stop-task-'))
	requests = []
	await mkdir(join(cwd, '.namzu'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('stop_task in the request the model gets', () => {
	it('is loaded on a default turn, cancel_agent is gone, and the system prompt carries the guidance', async () => {
		provider(async () => chunkResponse('Done.'))
		const session = await open()
		try {
			for await (const _ of session.send([createUserMessage('hello')])) {
				// drain
			}
		} finally {
			await session.close()
		}
		const names = toolNames(requests[0] as Request)
		expect(names).toContain('stop_task')
		expect(names).not.toContain('cancel_agent')
		const system = JSON.stringify(
			(requests[0] as Request).messages.filter((m) => m.role === 'system'),
		)
		expect(system).toContain(
			'Background work you started is yours to end: stop it (with `stop_task`, where offered) when the person changed course, a result in hand already answers the question, or an earlier stage failed; never because it is only slow. Say in one sentence what you stopped and why.',
		)
	})

	it('is loaded on a hypermode turn beside workflow, with the reminder that more agents are not a goal', async () => {
		provider(async () => chunkResponse('Done.'))
		const session = await open({ reminders: true })
		try {
			for await (const _ of session.send([createUserMessage('go')], {
				workflowReview: REVIEWER,
				hypermode: true,
			})) {
				// drain
			}
		} finally {
			await session.close()
		}
		const request = requests[0] as Request
		const names = toolNames(request)
		expect(names).toContain('workflow')
		expect(names).toContain('stop_task')
		expect(names).not.toContain('cancel_agent')
		expect(bodyOf(request)).toContain(
			'More agents are not a goal: stop a run with stop_task when its result can no longer change your answer.',
		)
	})
})

describe('a model that stops a live workflow run', () => {
	const SCRIPT = `export const meta = { name: 'staged', description: 'One, then two', phases: [{ title: 'Go' }] }
const first = await agent('STEP-ONE', { label: 'first', phase: 'Go' })
const rest = await parallel(['STEP-TWO', 'STEP-THREE'].map((p) => () => agent(p, { label: p, phase: 'Go' })))
return [first, ...rest]`

	it('aborts the running agents, and a resume reuses the saved result of the finished one', async () => {
		const started = new Set<string>()
		const startWaiters: Array<() => void> = []
		const aborted = new Set<string>()
		let resuming = false
		provider(async (request, signal) => {
			const body = bodyOf(request)
			if (!toolNames(request).includes('stop_task')) {
				// A workflow agent. In the first pass the second stage waits until it is aborted.
				const step = /STEP-(ONE|TWO|THREE)/.exec(body)?.[0] ?? 'unknown'
				started.add(step)
				for (const wake of startWaiters.splice(0)) wake()
				if (step !== 'STEP-ONE' && !resuming) {
					await new Promise<void>((_resolve, reject) => {
						signal?.addEventListener(
							'abort',
							() => {
								aborted.add(step)
								reject(new DOMException('aborted', 'AbortError'))
							},
							{ once: true },
						)
					})
				}
				return chunkResponse(`answer ${step}`)
			}
			// The conversation keeps its history, so only the latest real message decides.
			const latest = lastReal(request)
			if (latest.includes('Stop requested for workflow run')) return chunkResponse('Stopped it.')
			const receipt = /started in the background as (w[0-9a-z]{8})\./.exec(latest)
			if (receipt && !resuming) {
				while (!(started.has('STEP-TWO') && started.has('STEP-THREE')))
					await new Promise<void>((resolve) => startWaiters.push(resolve))
				return chunkResponse(undefined, { name: 'stop_task', input: { id: receipt[1] } })
			}
			if (receipt) return chunkResponse('Resumed.')
			if (resuming)
				return chunkResponse(undefined, {
					name: 'workflow',
					input: { script: SCRIPT, resumeFromRunId: resumeRunId },
				})
			return chunkResponse(undefined, { name: 'workflow', input: { script: SCRIPT } })
		})
		let resumeRunId = ''
		const session = await open()
		try {
			for await (const _ of session.send([createUserMessage('start the staged run')], {
				workflowReview: REVIEWER,
				hypermode: true,
			})) {
				// drain
			}
			const workflows = session.workflows
			await workflows?.idle()
			const [run] = workflows?.runs() ?? []
			expect(run?.status).toBe('stopped')
			resumeRunId = run?.runId ?? ''
			expect([...aborted].sort()).toEqual(['STEP-THREE', 'STEP-TWO'])
			expect(started.has('STEP-ONE')).toBe(true)
			expect(
				requests.some((r) => bodyOf(r).includes('Stop requested for workflow run ' + resumeRunId)),
			).toBe(true)

			// Continue the stopped run: the finished agent is not run again.
			resuming = true
			const childBefore = requests.filter((r) => !toolNames(r).includes('stop_task')).length
			for await (const _ of session.send([createUserMessage('continue it')], {
				workflowReview: REVIEWER,
				hypermode: true,
			})) {
				// drain
			}
			await workflows?.idle()
			const after = requests.filter((r) => !toolNames(r).includes('stop_task')).slice(childBefore)
			expect(after.map((r) => /STEP-(ONE|TWO|THREE)/.exec(bodyOf(r))?.[0]).sort()).toEqual([
				'STEP-THREE',
				'STEP-TWO',
			])
			expect(workflows?.runs().find((r) => r.runId === resumeRunId)?.status).toBe('completed')
		} finally {
			await session.close()
		}
	})
})

describe('a conversation resumed from before stop_task', () => {
	it('loads with its cancel_agent calls in the history, and is answered', async () => {
		provider(async () => chunkResponse('Carrying on.'))
		const session = await open()
		try {
			const history = [
				createUserMessage('stop the reviewer'),
				createAssistantMessage(null, [
					{
						id: 'call_old_cancel',
						type: 'function',
						function: { name: 'cancel_agent', arguments: JSON.stringify({ task_id: 'reviewer' }) },
					},
				]),
				createToolMessage(
					'Cancellation requested for task reviewer. Other tasks continue.',
					'call_old_cancel',
				),
				createUserMessage('thanks, now carry on'),
			]
			const events: string[] = []
			for await (const event of session.send(history)) events.push(event.kind)
			expect(events).toContain('done')
			expect(events).not.toContain('error')
			const sent = bodyOf(requests[0] as Request)
			expect(sent).toContain('call_old_cancel')
			expect(sent).toContain('cancel_agent')
			expect(toolNames(requests[0] as Request)).not.toContain('cancel_agent')
		} finally {
			await session.close()
		}
	})
})
