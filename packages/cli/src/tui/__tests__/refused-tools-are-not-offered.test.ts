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
import { type AgentSessionOptions, createAgentSession } from '../agent.js'

interface Request {
	readonly messages: readonly {
		readonly role: string
		readonly content?: unknown
	}[]
	readonly tools?: readonly {
		readonly function?: { readonly name?: string }
	}[]
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
		id: 'chatcmpl-refused-tools-fixture',
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

/** The first request the session sent: its tool names and its system prompt. */
async function firstRequest(
	options: AgentSessionOptions,
): Promise<{ tools: string[]; prompt: string }> {
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		memory: { recall: false },
		limits: { maxIterations: 3 },
		...options,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	try {
		for await (const _ of session.send([createUserMessage('Question.')])) {
			// Drain the production send.
		}
	} finally {
		await session.close()
	}
	const request = requests[0]
	return {
		tools: (request?.tools ?? []).map((tool) => tool.function?.name ?? ''),
		prompt: String(request?.messages.find((message) => message.role === 'system')?.content),
	}
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-refused-tools-'))
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

describe('a session that withholds the web tools', () => {
	it('offers them, with their guidance, when nothing withholds them', async () => {
		const { tools, prompt } = await firstRequest({})
		expect(tools).toContain('web_fetch')
		expect(tools).toContain('web_search')
		expect(prompt).toContain('## Using the web')
	})

	it('sends neither the tools nor the guidance written for them', async () => {
		const { tools, prompt } = await firstRequest({ withheldTools: ['web_fetch', 'web_search'] })
		expect(tools).not.toContain('web_fetch')
		expect(tools).not.toContain('web_search')
		expect(tools).toContain('bash')
		expect(prompt).not.toContain('## Using the web')
	})
})
