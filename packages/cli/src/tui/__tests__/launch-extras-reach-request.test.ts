import { mkdirSync, writeFileSync } from 'node:fs'
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
let home: string
let requests: Request[]

function reply(): Response {
	const chunk = {
		id: 'chatcmpl-launch-extras-fixture',
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
): Promise<{ tools: string[]; prompt: string; everything: string }> {
	requests = []
	const session = await createAgentSession(preferences, detected, {
		toolLoading: 'eager',
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
		prompt: (request?.messages ?? [])
			.filter((message) => message.role === 'system')
			.map((message) => String(message.content))
			.join('\n\n'),
		everything: JSON.stringify(request?.messages ?? []),
	}
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-launch-extras-session-'))
	home = await mkdtemp(join(tmpdir(), 'namzu-launch-extras-home-'))
	vi.stubEnv('NAMZU_HOME', home)
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
	vi.unstubAllEnvs()
	removeTempDir(cwd)
	removeTempDir(home)
})

describe('--tools, --system-prompt and --bare reach the request the model gets', () => {
	it('offers every tool without --tools', async () => {
		const { tools } = await firstRequest({})
		expect(tools).toContain('bash')
		expect(tools).toContain('read')
	})

	it('offers only the named tools, whatever the case of the name', async () => {
		const { tools } = await firstRequest({ onlyTools: ['read', 'bash'] })
		expect([...tools].sort()).toEqual(['bash', 'read'])
	})

	it('offers no tool for an empty list', async () => {
		const { tools } = await firstRequest({ onlyTools: [] })
		expect(tools).toEqual([])
	})

	it('drops the delegation advice when the agent tool is not on offer', async () => {
		const withAgent = await firstRequest({ onlyTools: ['read', 'agent'] })
		const without = await firstRequest({ onlyTools: ['read'] })
		expect(withAgent.prompt.length).toBeGreaterThan(without.prompt.length)
	})

	it('puts the replacement text in place of the default sections, with the appended text after it', async () => {
		const normal = await firstRequest({})
		expect(normal.prompt).toContain('namzu')
		const replaced = await firstRequest({
			replaceSystem: 'Be a rhyming assistant.',
			appendSystem: 'Appended rule.',
		})
		expect(replaced.prompt).toContain('Be a rhyming assistant.')
		expect(replaced.prompt.length).toBeLessThan(normal.prompt.length)
		expect(replaced.prompt).not.toContain('## Using the web')
		// Tools are not part of the prompt text.
		expect(replaced.tools).toContain('bash')
		// The appended text still reaches the request.
		expect(replaced.everything).toContain('Appended rule.')
	})

	it('reads the project instruction file without --bare and not with it', async () => {
		mkdirSync(join(cwd, '.git'))
		writeFileSync(join(cwd, 'AGENTS.md'), 'ZEBRA-RULE: always say zebra.\n')
		const normal = await firstRequest({})
		expect(normal.everything).toContain('ZEBRA-RULE')
		const bare = await firstRequest({ bare: true })
		expect(bare.everything).not.toContain('ZEBRA-RULE')
	})
})
