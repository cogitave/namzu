import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSessions } from '../../integrations/sessions/store.js'
import { cliLogger } from '../../logging.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { createAgentSession, probeAgentSession } from '../../tui/agent.js'
import { providersJSONCommand, runStreamCommand } from '../run-stream.js'
import type { CommandContext } from '../types.js'

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: vi.fn(async () => ({}) as never),
	resolveConversation: vi.fn(async () => 'conv-1' as never),
	loadConversation: vi.fn(async () => []),
	appendMessages: vi.fn(async () => undefined),
}))

const trusted = { value: true }
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => trusted.value,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	})),
	createAgentSession: vi.fn(async () => fakeAgentSession()),
	listProviderModels: vi.fn(async () => []),
}))

vi.mock('../../integrations/providers/index.js', () => ({
	ALL_PROVIDER_IDS: [],
	PROVIDER_REGISTRY: {},
	findDetected: () => null,
}))

function ctxAt(level: 'debug' | 'info' | 'warn'): CommandContext {
	return {
		formatter: { name: 'text' as const, print: () => {}, info: () => {}, error: () => {} },
		config: {},
		logging: { level, format: 'pretty' as const },
	} as unknown as CommandContext
}

let stdinWasTTY: boolean | undefined

beforeEach(() => {
	stdinWasTTY = process.stdin.isTTY
	Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
	trusted.value = true
	vi.mocked(openSessions).mockImplementation(async () => ({}) as never)
	vi.mocked(probeAgentSession).mockImplementation(async () => ({
		preferences: { version: 3, providers: [{ id: 'anthropic' }], subagents: { active: [] } },
		needsRepickReason: null,
		credentialGap: null,
		detected: [],
	}))
	vi.mocked(createAgentSession).mockImplementation(async () => fakeAgentSession())
})

afterEach(() => {
	Object.defineProperty(process.stdin, 'isTTY', { value: stdinWasTTY, configurable: true })
	vi.restoreAllMocks()
})

describe('namzu run-stream installs a live stderr sink instead of silencing the SDK logger', () => {
	it('the sink is always NDJSON on stderr, even when ctx.logging.format is pretty', async () => {
		const lines: string[] = []
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			lines.push(String(chunk))
			return true
		})
		try {
			await runStreamCommand.handler({ ctx: ctxAt('debug'), rawArgs: ['hi'] })
			cliLogger().debug('probe')
			const out = lines.join('')
			expect(out).toContain('"body":"probe"')
			expect(out).toContain('"severityText":"debug"')
		} finally {
			spy.mockRestore()
		}
	})

	it('stdout — the NDJSON protocol — is byte-identical whether or not --verbose raised the log floor', async () => {
		async function stdoutFor(level: 'debug' | 'info'): Promise<string> {
			const lines: string[] = []
			const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
				lines.push(String(chunk))
				return true
			})
			try {
				await runStreamCommand.handler({ ctx: ctxAt(level), rawArgs: ['hi'] })
				return lines.join('')
			} finally {
				spy.mockRestore()
			}
		}
		const quiet = await stdoutFor('info')
		const verbose = await stdoutFor('debug')
		expect(verbose).toBe(quiet)
	})
})

describe('namzu providers-json installs a live stderr sink instead of silencing the SDK logger', () => {
	it('now receives ctx and installs the sink at its resolved level', async () => {
		const lines: string[] = []
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			lines.push(String(chunk))
			return true
		})
		try {
			await providersJSONCommand.handler({ ctx: ctxAt('debug'), rawArgs: [] })
			cliLogger().debug('providers-json probe')
			expect(lines.join('')).toContain('providers-json probe')
		} finally {
			spy.mockRestore()
		}
	})
})
