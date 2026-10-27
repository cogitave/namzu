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

/**
 * `--append-system-prompt` is for instructions that change from one run to the
 * next, so they must not move the part of the prompt a provider caches. The
 * session is real; only the network is faked, and the request it sends is read.
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
const APPENDED = 'APPENDED_RUN_INSTRUCTION: answer in the voice of a lighthouse keeper.'

let cwd: string
let requests: Request[]

function stubProvider(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Request)
			const chunk = {
				id: 'chatcmpl-append-fixture',
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
		}),
	)
}

/** The system messages of the one request a run sent, in order. */
async function systemMessagesOf(options: AgentSessionOptions): Promise<string[]> {
	requests = []
	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
		plugins: { enabled: false },
		memory: { recall: false },
		limits: { maxIterations: 2 },
		...options,
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
	try {
		for await (const _ of session.send([createUserMessage('Say hello')])) {
			// Drain the real query through the fake provider transport.
		}
	} finally {
		await session.close()
	}
	expect(requests).toHaveLength(1)
	return (requests[0]?.messages ?? [])
		.filter((message) => message.role === 'system')
		.map((message) => String(message.content))
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-append-system-'))
	stubProvider()
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('appended system instructions reach the model after the cached prompt', () => {
	it('sends the text, and everything the run sent before it is what a run without it sends', async () => {
		const without = (await systemMessagesOf({})).join('\n\n')
		const withText = (await systemMessagesOf({ appendSystem: APPENDED })).join('\n\n')
		expect(without).not.toContain('APPENDED_RUN_INSTRUCTION')
		expect(withText).toContain(APPENDED)
		// The cached prefix is untouched: the prompt without the flag is the front of the prompt with it.
		expect(withText.startsWith(without)).toBe(true)
		expect(withText.slice(without.length)).toContain(APPENDED)
	})
})
