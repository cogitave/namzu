import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { AgentSession, SendOptions } from '../../tui/agent.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/** A prompt sent over ACP is what the person typed, so a `+500k` in it sets a token target. */

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-typed-input-'))
	cwd = join(root, 'project')
	mkdirSync(cwd)
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

it('hands the prompt text to the session as typed input', async () => {
	const seen: Array<SendOptions | undefined> = []
	const send: AgentSession['send'] = async function* (_messages, options) {
		seen.push(options)
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const deps = {
		probe: async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: (value: unknown) => value,
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async () => ({
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
		}),
	} as unknown as AcpRuntimeDependencies
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		deps,
	)
	await runtime.gateway.prompt({
		sessionId: 'session-typed',
		cwd,
		prompt: 'audit everything +500k',
		history: [],
		signal: new AbortController().signal,
		onEvent() {},
		ask: async () => ({ kind: 'approve' }),
		filesystem: undefined,
	})
	expect(seen[0]?.typedInput).toBe('audit everything +500k')
})
