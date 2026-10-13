import { PassThrough } from 'node:stream'

import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { execCommand } from '../exec.js'
import type { CommandContext } from '../types.js'

/**
 * Piped input next to a prompt argument is material the question is about
 * (`cat notes.txt | namzu exec "summarise this"`). Its quarter second to
 * start runs alongside the rest of the startup, but the text must still end up
 * in the message that is sent, exactly as before.
 */

const { sent, whenCreating } = vi.hoisted(() => ({
	sent: [] as Message[][],
	whenCreating: { run: (): void => {} },
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	closeSessions: vi.fn(),
	openSessions: vi.fn(async () => ({
		root: '/state',
		backend: 'central',
		topicId: 'f29dac4e-8d04-41db-9b29-5ac5e34b28e3',
		projectId: '18afaab4-f803-4cfe-87ad-ea9f1b7edbbf',
		tenantId: '3daaeb04-b9ef-46a0-888d-ba45672be60c',
	})),
	startConversation: vi.fn(async () => '0f2c1c8e-5c0e-4f43-9a8c-9d6f0a6c3b11'),
	resolveConversation: vi.fn(),
	loadConversation: vi.fn(),
	appendMessages: vi.fn(),
	replaceConversation: vi.fn(),
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: {
			version: 3 as const,
			providers: [{ id: 'deepseek' as const }],
			subagents: { active: [] as string[] },
		},
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async () => {
		whenCreating.run()
		return fakeAgentSession({
			providerSummary: 'stub',
			modelSummary: 'stub',
			send: async function* (messages: readonly Message[]) {
				sent.push([...messages])
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		})
	}),
}))

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
let pipe: PassThrough

const ctx = {
	formatter: { name: 'text' as const, print: () => {}, info: () => {}, error: () => {} },
	config: {},
} as unknown as CommandContext

beforeEach(() => {
	sent.length = 0
	whenCreating.run = () => {}
	// The quarter second is the clock under test and must not run out while the
	// stub session is built, however slow the machine: it is never advanced.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	pipe = new PassThrough()
	Object.defineProperty(process, 'stdin', {
		configurable: true,
		get: () => Object.assign(pipe, { isTTY: false }),
	})
	vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
})

const run = (rawArgs: string[]) =>
	execCommand.handler({ rawArgs: ['--cwd', process.cwd(), '--trust', ...rawArgs], ctx })

describe('namzu exec with piped input', () => {
	it('sends the question with the piped text fenced after it', async () => {
		pipe.end('the file contents')

		expect(await run(['summarise this'])).toBe(0)

		expect(sent).toHaveLength(1)
		expect(sent[0]?.at(-1)?.content).toBe('summarise this\n\n<stdin>\nthe file contents\n</stdin>')
	})

	it('does not hold the startup back for input that has not started', async () => {
		// The pipe is silent until the session is being built. Before, the
		// command waited out its quarter second before getting that far, and the
		// text that arrived afterwards was lost.
		whenCreating.run = () => {
			pipe.end('material that arrived during startup')
		}

		expect(await run(['summarise this'])).toBe(0)

		expect(sent[0]?.at(-1)?.content).toBe(
			'summarise this\n\n<stdin>\nmaterial that arrived during startup\n</stdin>',
		)
	})

	it('sends the question alone when nothing is piped', async () => {
		pipe.end()

		expect(await run(['just this'])).toBe(0)

		expect(sent[0]?.at(-1)?.content).toBe('just this')
	})

	it('takes the whole prompt from the pipe when there is no argument', async () => {
		pipe.end('the prompt, piped')

		expect(await run([])).toBe(0)

		expect(sent[0]?.at(-1)?.content).toBe('the prompt, piped')
	})
})
