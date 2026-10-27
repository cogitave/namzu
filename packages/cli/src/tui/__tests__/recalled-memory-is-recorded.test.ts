import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MarkdownMemoryStore, createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

/**
 * Project memory recalled for a turn is recorded in the conversation, after
 * the operator's message, rather than shown as request-only context. Driven
 * through a real session with the network stubbed.
 */

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
const QUESTION = 'What did we learn about cerulean-cache expiry?'

let root: string
let cwd: string
let home: string
let requests: Request[]

function reply(): Response {
	const chunk = {
		id: 'chatcmpl-recalled-memory-fixture',
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

const open = () =>
	createAgentSession(preferences, detected, {
		cwd,
		stateRoot: home,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		web: { search: 'off' },
		limits: { maxIterations: 3 },
	})

async function drain(session: Awaited<ReturnType<typeof open>>): Promise<void> {
	for await (const _ of session.send([createUserMessage(QUESTION)])) {
		// Drain the production send.
	}
}

const text = (message: { readonly content?: unknown }): string =>
	typeof message.content === 'string' ? message.content : JSON.stringify(message.content)

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-recalled-memory-'))
	cwd = join(root, 'work')
	home = join(root, 'home')
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
	removeTempDir(root)
})

describe('recalled project memory', () => {
	it('arrives as a recorded entry after the operator message', async () => {
		const { mkdirSync } = await import('node:fs')
		mkdirSync(cwd, { recursive: true })
		// The first session creates the project's directories; stored memory is
		// seeded into the one it made, then a second session recalls it.
		const first = await open()
		expect(first.hasProvider, first.errorHint ?? undefined).toBe(true)
		await first.close()
		const [slug] = await readdir(join(home, 'projects'))
		const store = new MarkdownMemoryStore({
			directory: join(home, 'projects', String(slug), 'memory'),
		})
		await store.create({
			title: 'Cache finding',
			summary: 'One discovery',
			content: 'cerulean-cache expires after 14 hours',
		})

		const session = await open()
		try {
			await drain(session)
		} finally {
			await session.close()
		}

		const messages = requests[0]?.messages ?? []
		const asked = messages.findIndex((m) => m.role === 'user' && text(m).includes(QUESTION))
		const recalled = messages.findIndex(
			(m) => m.role === 'user' && text(m).includes('cerulean-cache expires after 14 hours'),
		)
		expect(asked).toBeGreaterThan(-1)
		expect(recalled, 'recalled after the question, as history').toBeGreaterThan(asked)
		expect(text(messages[recalled] ?? {})).toMatch(/^Recorded context .* - memory, as of /)
	})
})
