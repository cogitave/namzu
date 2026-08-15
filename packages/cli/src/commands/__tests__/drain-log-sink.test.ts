import { describe, expect, it, vi } from 'vitest'

import { getRootLogger } from '@namzu/sdk'

import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import type { CommandContext } from '../types.js'

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		drainRuns: async () => ({}),
	}
})

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 3, providers: [{ id: 'mock' }], subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => fakeAgentSession()),
}))

const { drainCommand } = await import('../drain.js')

const SCOPE_ARGS = [
	'--store',
	'/tmp/runs',
	'--tenant',
	'tnt_x',
	'--project',
	'prj_x',
	'--session',
	'ses_x',
]

function ctxAt(level: 'debug' | 'warn'): CommandContext {
	return {
		formatter: { name: 'json' as const, print: () => {}, info: () => {}, error: () => {} },
		config: {},
		logging: { level, format: 'json' as const },
	} as unknown as CommandContext
}

describe('namzu drain installs a live stderr sink instead of silencing the SDK logger', () => {
	it('--verbose (level=debug): a debug record reaches stderr', async () => {
		const lines: string[] = []
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			lines.push(String(chunk))
			return true
		})
		try {
			await drainCommand.handler({ ctx: ctxAt('debug'), rawArgs: SCOPE_ARGS })
			getRootLogger().debug('drain debug probe')
			expect(lines.join('')).toContain('drain debug probe')
		} finally {
			spy.mockRestore()
		}
	})

	it('--quiet (level=warn): a debug probe does not reach stderr', async () => {
		const lines: string[] = []
		const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
			lines.push(String(chunk))
			return true
		})
		try {
			await drainCommand.handler({ ctx: ctxAt('warn'), rawArgs: SCOPE_ARGS })
			getRootLogger().debug('should not appear')
			expect(lines.join('')).not.toContain('should not appear')
		} finally {
			spy.mockRestore()
		}
	})
})
