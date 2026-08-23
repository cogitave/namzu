import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.js'
import type { CommandContext } from '../types.js'

const starts = vi.hoisted(() => ({
	browser: vi.fn(),
	codex: vi.fn(),
}))

vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		beginSubscriptionLogin: (...args: unknown[]) => starts.browser(...args),
		beginCodexDeviceLogin: (...args: unknown[]) => starts.codex(...args),
	}
})

vi.mock('../../tui/open-browser.js', () => ({ openInBrowser: () => true }))

const { loginCommand } = await import('../login.js')

function context() {
	const lines: string[] = []
	const ctx = {
		config: {},
		formatter: {
			name: 'text' as const,
			print: ({ text }: { text: string }) => {
				lines.push(text)
			},
			info: (message: string) => {
				lines.push(message)
			},
			error: ({ message }: { message: string }) => {
				lines.push(message)
			},
		},
	} satisfies CommandContext
	return { ctx, lines }
}

beforeEach(() => {
	starts.browser.mockReset()
	starts.codex.mockReset()
	starts.browser.mockResolvedValue({
		url: 'https://browser.example.test/authorize',
		redirectUri: 'https://callback.example.test/oauth/code',
		completeWithPastedCode: () =>
			Promise.resolve({
				ok: true as const,
				credential: { accessToken: 'claude-secret' },
				storedAt: '/home/test/.namzu/credentials.json',
			}),
		cancel: vi.fn(),
	})
	starts.codex.mockResolvedValue({
		url: 'https://codex.example.test/device',
		userCode: 'ABCD-EFGH',
		waitForCompletion: () =>
			Promise.resolve({
				ok: true as const,
				credential: { accessToken: 'codex-secret', accountId: 'account-1' },
				storedAt: '/home/test/.namzu/credentials.json',
			}),
		cancel: vi.fn(),
	})
})

describe('namzu login provider routing', () => {
	it('requires a provider instead of silently choosing Claude', async () => {
		const { ctx, lines } = context()

		const code = await loginCommand.handler({ ctx, rawArgs: [] })

		expect(code).toBe(EXIT_USAGE)
		expect(lines.join('\n')).toContain('namzu login claude')
		expect(lines.join('\n')).toContain('namzu login codex')
		expect(starts.browser).not.toHaveBeenCalled()
		expect(starts.codex).not.toHaveBeenCalled()
	})

	it('starts only the Claude browser flow when Claude is selected', async () => {
		const { ctx, lines } = context()

		const pending = loginCommand.handler({ ctx, rawArgs: ['claude'] })
		await vi.waitFor(() => expect(starts.browser).toHaveBeenCalledTimes(1))
		process.stdin.emit('data', 'copied-code\n')
		const code = await pending

		expect(code).toBe(EXIT_OK)
		expect(starts.browser).toHaveBeenCalledTimes(1)
		expect(starts.codex).not.toHaveBeenCalled()
		expect(lines.join('\n')).not.toContain('claude-secret')
	})

	it('starts only the Codex device flow when Codex is selected', async () => {
		const { ctx, lines } = context()

		const code = await loginCommand.handler({ ctx, rawArgs: ['codex'] })

		expect(code).toBe(EXIT_OK)
		expect(starts.codex).toHaveBeenCalledTimes(1)
		expect(starts.browser).not.toHaveBeenCalled()
		expect(lines.join('\n')).toContain('ABCD-EFGH')
		expect(lines.join('\n')).not.toContain('codex-secret')
	})
})
