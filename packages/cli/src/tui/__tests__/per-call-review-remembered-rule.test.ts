/**
 * "Yes, and don't ask again" on the first of several identical shell calls
 * must cover the next one. This drives the real session and the real kernel
 * walk through a scripted provider and the terminal's own per-call config; only
 * the person's answer is played.
 */

import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
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
import { allowsFor } from '../../permissions/session-allow.js'
import { createAgentSession } from '../agent.js'
import { createTerminalPerCallReview } from '../per-call-review.js'

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
let requests = 0

function chunk(delta: Record<string, unknown>, finish: string): Response {
	const body = {
		id: 'chatcmpl-rule',
		object: 'chat.completion.chunk',
		created: 1,
		model: 'deepseek-chat',
		choices: [{ index: 0, delta, finish_reason: finish }],
		usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
	}
	return new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-remembered-rule-'))
	await mkdir(join(cwd, '.namzu'))
	requests = 0
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async () => {
			requests += 1
			if (requests > 1) return chunk({ content: 'Done.' }, 'stop')
			return chunk(
				{
					tool_calls: ['a', 'b', 'c'].map((id, index) => ({
						index,
						id: `call_${id}`,
						type: 'function',
						function: { name: 'bash', arguments: JSON.stringify({ command: 'touch same.txt' }) },
					})),
				},
				'tool_calls',
			)
		}),
	)
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	removeTempDir(cwd)
})

describe('a remembered answer covers the identical calls that follow it', () => {
	it('asks once for three identical shell calls when the first answer is remembered', async () => {
		const session = await createAgentSession(preferences, detected, {
			cwd,
			sandbox: { enabled: false },
			plugins: { enabled: false },
			memory: { recall: false },
			limits: { maxIterations: 3 },
		})
		expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)
		const live = createTerminalPerCallReview({ mode: () => 'prompt' })
		const asked: string[] = []
		try {
			for await (const _ of session.send([createUserMessage('go')], {
				perCallReview: live.config,
				onPermission: async (request) => {
					asked.push(...request.toolCalls.map((call) => call.id))
					for (const call of request.toolCalls) live.hold(call.id, false)
					const commands = session.commandArguments
					const allows = commands ? allowsFor(request.toolCalls[0] as never, commands) : undefined
					expect(allows).toBeDefined()
					session.allowForSession?.(allows ?? [])
					live.rulesChanged()
					return { kind: 'approve' }
				},
			})) {
				// Drain the turn.
			}
		} finally {
			await session.close()
		}
		expect(asked).toEqual(['call_a'])
		await expect(readFile(join(cwd, 'same.txt'), 'utf8')).resolves.toBe('')
	})
})
