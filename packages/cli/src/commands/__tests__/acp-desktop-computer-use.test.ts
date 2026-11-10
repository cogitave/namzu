import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'

/**
 * The desktop runs `namzu acp --desktop`; the host `computer_use` tool is only
 * mounted when the session is built with `enableComputerUse`. These tests read
 * the options the runtime hands the session builder. No session is real and no
 * desktop is touched.
 */

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-acp-desktop-cu-'))
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

async function optionsSeen(
	runtimeOptions?: Parameters<typeof createCliAcpRuntime>[2],
): Promise<Record<string, unknown>> {
	let seen: Record<string, unknown> = {}
	const deps = {
		probe: async () => ({
			preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
			detected: [],
		}),
		decideTrust: ({ cwd }: { cwd: string }) => ({ allowed: true, cwd }),
		resolveProjectContext: (value: unknown) => value,
		resolveSession: async (sessionId: string) => ({ sessionId }),
		createSession: async (_p: unknown, _d: unknown, options: Record<string, unknown>) => {
			seen = options
			return {
				hasProvider: true,
				errorHint: null,
				mcpFailed: [],
				send: async function* () {
					yield { kind: 'done', stopReason: 'end_turn' }
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
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		deps,
		runtimeOptions,
	)
	await runtime.gateway.prompt({
		sessionId: 'session-cu',
		cwd,
		prompt: 'hello',
		history: [],
		signal: new AbortController().signal,
		onEvent() {},
		ask: async () => ({ kind: 'approve' }),
		filesystem: undefined,
	})
	return seen
}

it('mounts the host computer for the desktop', async () => {
	expect((await optionsSeen({ computerUse: true })).enableComputerUse).toBe(true)
})

it('leaves a bare ACP client without it', async () => {
	expect('enableComputerUse' in (await optionsSeen())).toBe(false)
	expect('enableComputerUse' in (await optionsSeen({ computerUse: false }))).toBe(false)
})
