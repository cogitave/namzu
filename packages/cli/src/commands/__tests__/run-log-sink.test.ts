import { describe, expect, it, vi } from 'vitest'

import { getRootLogger } from '@namzu/sdk'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { runCommand } from '../run.js'
import type { CommandContext } from '../types.js'

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => fakeAgentSession()),
}))

function ctxAt(level: 'debug' | 'info' | 'warn'): CommandContext {
	return {
		formatter: { name: 'text' as const, print: () => {}, info: () => {}, error: () => {} },
		config: {},
		logging: { level, format: 'json' as const },
	} as unknown as CommandContext
}

async function runAndProbe(level: 'debug' | 'info' | 'warn'): Promise<string> {
	const lines: string[] = []
	const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
		lines.push(String(chunk))
		return true
	})
	try {
		await runCommand.handler({ ctx: ctxAt(level), rawArgs: ['hi'] })
		getRootLogger().debug('debug probe')
		getRootLogger().info('info probe')
		getRootLogger().warn('warn probe')
		return lines.join('')
	} finally {
		spy.mockRestore()
	}
}

describe('namzu run installs a live stderr sink instead of silencing the SDK logger', () => {
	it('--verbose (level=debug): a debug record reaches stderr', async () => {
		const out = await runAndProbe('debug')
		expect(out).toContain('debug probe')
	})

	it('--quiet (level=warn): nothing below warn reaches stderr', async () => {
		const out = await runAndProbe('warn')
		expect(out).not.toContain('debug probe')
		expect(out).not.toContain('info probe')
		expect(out).toContain('warn probe')
	})

	it('the default (level=info): info reaches stderr, debug does not', async () => {
		const out = await runAndProbe('info')
		expect(out).toContain('info probe')
		expect(out).not.toContain('debug probe')
	})
})
