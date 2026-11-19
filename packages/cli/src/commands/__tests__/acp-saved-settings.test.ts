import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { sessionOptionsFromConfig } from '../../config/session-options.js'
import type { AgentSessionOptions, SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/** A Desktop conversation honours the engine settings the terminal's `exec` honours. */

let root: string
let cwd: string
beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] })
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-saved-settings-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const config = {
	limits: {
		maxResponseTokens: 512,
		doneGate: false,
		tokenBudget: 100,
		costLimitUsd: 0.5,
	},
	workflow: { maxAgents: 2 },
	handBack: { enabled: true },
	compaction: { clearStaleResultsAfterIdle: true },
	hypermode: true,
	refusalFallback: 'off',
	additionalDirectories: ['extra'],
	toolResultScreens: [],
}

function build() {
	const created: AgentSessionOptions[] = []
	const sent: Array<SendOptions | undefined> = []
	let call = 0
	const deps = {
		probe: async () => ({
			preferences: {
				version: 3,
				providers: [{ id: 'mock' }],
				subagents: { active: [] },
			},
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: (value: unknown) => value,
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async (_p: unknown, _d: unknown, options: AgentSessionOptions) => {
			created.push(options)
			return {
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				clearStaleResultsAfterIdle: true,
				send: async function* (_m: unknown, opts?: SendOptions) {
					sent.push(opts)
					call += 1
					// The first call reports a five minute prompt cache it touched.
					if (call === 1)
						yield {
							kind: 'usage',
							cache: { ttlMs: 300_000, touched: true },
						} as never
					yield { kind: 'done', stopReason: 'end_turn' } as const
				},
				close: async () => {},
				presenter: {
					presentCall: () => ({ kind: 'generic', label: 'Fixture' }),
					presentResult: () => ({ kind: 'generic', label: 'Fixture' }),
				},
				jobs: () => [],
			}
		},
	} as unknown as AcpRuntimeDependencies
	const runtime = createCliAcpRuntime(
		{
			config,
			formatter: { name: 'text', print() {}, info() {}, error() {} },
		} as never,
		deps,
	)
	const prompt = () =>
		runtime.gateway.prompt({
			sessionId: 'session-saved',
			cwd,
			prompt: 'hello',
			history: [],
			signal: new AbortController().signal,
			onEvent() {},
			ask: async () => ({ kind: 'approve' }),
			filesystem: undefined,
		})
	return { runtime, created, sent, prompt }
}

it('builds the session with the options exec builds from the same configuration', async () => {
	const { created, prompt, runtime } = build()
	await prompt()
	const expected = sessionOptionsFromConfig(config as never, { cwd })
	expect(created[0]).toMatchObject(expected)
	expect(created[0]?.limits).toEqual(config.limits)
	expect(created[0]?.handBack).toBe(true)
	expect(created[0]?.workflow).toEqual(config.workflow)
	await runtime.close()
})

it('sends hypermode and the refusal fallback with every turn, as the terminal does', async () => {
	const { sent, prompt, runtime } = build()
	await prompt()
	expect(sent[0]).toMatchObject({ hypermode: true, refusalFallback: 'off' })
	await runtime.close()
})

it('sheds old tool results once the prompt cache has lapsed, and not before', async () => {
	const { sent, prompt, runtime } = build()
	await prompt()
	expect(sent[0]).not.toHaveProperty('clearStaleToolResults')
	vi.setSystemTime(Date.now() + 60_000)
	await prompt()
	expect(sent[1]).not.toHaveProperty('clearStaleToolResults')
	vi.setSystemTime(Date.now() + 10 * 60_000)
	await prompt()
	expect(sent[2]).toHaveProperty('clearStaleToolResults')
	await runtime.close()
})
