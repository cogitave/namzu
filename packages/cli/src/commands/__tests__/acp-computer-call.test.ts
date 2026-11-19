import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { AgentSession, SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/**
 * What `namzu acp` tells the desktop about a computer action: which application the request works
 * on and why it is still asked about in an allowed application (so the window can keep an
 * application's yes for the conversation), and the picture the model saw (so it can show it).
 */

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-computer-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const click = {
	id: 'c1',
	name: 'computer_use',
	input: { type: 'mouse_click' },
	isDestructive: true,
}
const bash = { id: 'c2', name: 'bash', input: { command: 'ls' }, isDestructive: true }

async function run(options: {
	calls: Record<string, unknown>[]
	described?: (name: string) => { app?: string; consequence?: string } | undefined
	observeComputer?: (id: string, seen: unknown) => void
}) {
	let sessionOptions: Record<string, unknown> | undefined
	const send = vi.fn((_messages: unknown, sendOptions: SendOptions) =>
		(async function* () {
			await sendOptions.onPermission?.({ toolCalls: options.calls } as never)
			yield { kind: 'done', stopReason: 'end_turn' } as const
		})(),
	) as unknown as AgentSession['send']
	const runtime = createCliAcpRuntime(
		{
			config: { computerUse: { enabled: true } },
			formatter: { name: 'text', print() {}, info() {}, error() {} },
		},
		{
			probe: async () => ({
				preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
				detected: [],
			}),
			decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
			resolveProjectContext: (value: unknown) => value,
			resolveSession: async (sessionId: string) => ({ sessionId }),
			createSession: async (
				_prefs: unknown,
				_detected: unknown,
				created: Record<string, unknown>,
			) => {
				sessionOptions = created
				return {
					hasProvider: true,
					errorHint: null,
					mcpFailed: [],
					send,
					close: async () => {},
					presenter: {
						presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
						presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
					},
					jobs: () => [],
					describeComputerUseCall: async (name: string) => options.described?.(name),
				}
			},
		} as unknown as AcpRuntimeDependencies,
		{
			computerUse: true,
			...(options.observeComputer ? { observeComputer: options.observeComputer } : {}),
		},
	)
	const ask = vi.fn(async () => ({ kind: 'approve' as const }))
	try {
		await runtime.gateway.prompt({
			sessionId: 'session-1',
			cwd,
			prompt: 'Open Notepad',
			history: [],
			signal: new AbortController().signal,
			onEvent() {},
			ask,
			filesystem: undefined,
		})
	} finally {
		await runtime.close()
	}
	return { ask, sessionOptions }
}

describe('a computer action asked about', () => {
	it('carries the application and the reason it is still asked in an allowed one', async () => {
		const { ask } = await run({
			calls: [click, bash],
			described: (name) =>
				name === 'computer_use' ? { app: 'Notepad', consequence: 'presses ALT+F4' } : undefined,
		})
		const calls = (ask.mock.calls[0] as unknown as [{ toolCalls: Record<string, unknown>[] }])[0]
			.toolCalls
		expect(calls[0]).toMatchObject({ computer: { app: 'Notepad', consequence: 'presses ALT+F4' } })
		// Another tool says nothing about a computer.
		expect(calls[1]).not.toHaveProperty('computer')
	})

	it('sends nothing extra when the application cannot be told', async () => {
		const { ask } = await run({ calls: [click] })
		const calls = (ask.mock.calls[0] as unknown as [{ toolCalls: Record<string, unknown>[] }])[0]
			.toolCalls
		expect(calls[0]).not.toHaveProperty('computer')
	})
})

describe('the picture the model saw', () => {
	it('is handed to the host with the conversation it belongs to', async () => {
		const seen: unknown[] = []
		const { sessionOptions } = await run({
			calls: [click],
			observeComputer: (id, observation) => seen.push([id, observation]),
		})
		const hand = sessionOptions?.onComputerObservation as ((value: unknown) => void) | undefined
		expect(hand).toBeTypeOf('function')
		hand?.({ frameId: 's1' })
		expect(seen).toEqual([['session-1', { frameId: 's1' }]])
	})

	it('is not asked for when the host does not want it', async () => {
		const { sessionOptions } = await run({ calls: [click] })
		expect(sessionOptions).not.toHaveProperty('onComputerObservation')
	})
})
