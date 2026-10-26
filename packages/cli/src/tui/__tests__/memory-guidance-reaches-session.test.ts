import { mkdtemp } from 'node:fs/promises'
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
import { composeMemoryGuidance } from '../../memory/typed.js'
import { type AgentSessionOptions, createAgentSession } from '../agent.js'

interface Request {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[]
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
let cwd: string
let requests: Request[]

function reply(): Response {
	const chunk = {
		id: 'chatcmpl-memory-guidance-fixture',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'deepseek-chat',
		choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
	}
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

async function turn(options: AgentSessionOptions, count = 1): Promise<string[]> {
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		web: { search: 'off' },
		memory: { recall: false },
		limits: { maxIterations: 3 },
		...options,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	try {
		for (let i = 0; i < count; i++) {
			for await (const _ of session.send([createUserMessage(`Question ${i}.`)])) {
				// Drain the production send.
			}
		}
	} finally {
		await session.close()
	}
	return requests.map((request) =>
		String(request.messages.find((message) => message.role === 'system')?.content),
	)
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-memory-guidance-'))
	requests = []
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Request)
			return reply()
		}),
	)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

const WITH_TASKS = composeMemoryGuidance({ taskList: true })
const WITHOUT_TASKS = composeMemoryGuidance({ taskList: false })

describe('memory guidance in the assembled system prompt', () => {
	it('is present, once, in the stable prefix when the memory tools are mounted', async () => {
		const [prompt] = await turn({})
		expect(prompt).toContain(WITH_TASKS)
		expect(prompt.split('## Memory').length).toBe(2)
		// Before the environment block, which carries per-launch facts.
		expect(prompt.indexOf(WITH_TASKS)).toBeLessThan(prompt.indexOf('## Environment'))
	})

	it('is absent when the session withholds the memory tools', async () => {
		const [prompt] = await turn({ withheldTools: ['save_memory'] })
		expect(prompt).not.toContain('## Memory')
		expect(prompt).not.toContain(WITH_TASKS)
	})

	it('names the task list only when the session has one', async () => {
		const [withTasks] = await turn({})
		expect(withTasks).toContain('belong in the task list')
		requests = []
		const [withoutTasks] = await turn({ withheldTools: ['task_create'] })
		expect(withoutTasks).toContain(WITHOUT_TASKS)
		expect(withoutTasks).not.toContain('belong in the task list')
		expect(withoutTasks).toContain('belong in the conversation')
	})

	it('keeps its sentences in the same order on every turn', async () => {
		const prompts = await turn({}, 2)
		expect(prompts).toHaveLength(2)
		expect(prompts[1]).toBe(prompts[0])
		const sentences = WITH_TASKS.split(/(?<=[.:;])\s+/)
		let at = -1
		for (const sentence of sentences) {
			const next = prompts[1].indexOf(sentence)
			expect(next, sentence).toBeGreaterThan(at)
			at = next
		}
	})
})

describe('memory guidance wording', () => {
	const both = [WITH_TASKS, WITHOUT_TASKS]

	it('uses plain emphasis, with no run of capital letters', () => {
		for (const text of both) expect(text).not.toMatch(/\b[A-Z]{3,}\b/)
	})

	it('names no other product or vendor', () => {
		for (const text of both) {
			expect(text).not.toMatch(
				/claude|anthropic|openai|chatgpt|gemini|copilot|cursor|codex|llama|mistral/i,
			)
		}
	})

	it('does not tell the model or the person to start over', () => {
		for (const text of both) {
			expect(text).not.toMatch(/start over|new session|start fresh|\/clear|\/new/i)
		}
	})

	it('leaves tool mechanics to the tool descriptions', () => {
		for (const text of both) expect(text).not.toMatch(/How to apply|\[\[|revision|kebab/)
	})

	it('states the purpose without pressing the model to save eagerly', () => {
		for (const text of both) {
			expect(text).not.toMatch(/left unwritten|repeated by the next/i)
			expect(text).toContain('expect to matter again')
		}
	})

	it('saves a failure lesson only when it will recur or was not obvious', () => {
		for (const text of both) {
			expect(text).toContain('likely to come up again or was not obvious')
			expect(text).toContain('a one-off slip')
		}
	})

	it('says an explicit ask to remember yields to the leave-out rule for what the repository holds', () => {
		for (const text of both) {
			expect(text).toContain(
				'If the repository already records it, save only what was surprising or non-obvious about it.',
			)
		}
	})
})
