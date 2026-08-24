import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.js'
import type { CommandContext } from '../types.js'

const credentials = vi.hoisted(() => ({
	primary: true,
	codex: true,
	clears: [] as string[],
}))

vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		credentialsPath: () => '/device/.namzu/credentials.json',
		readStoredSubscriptionCredential: () =>
			credentials.primary ? { accessToken: 'claude-secret' } : null,
		readStoredCodexCredential: () =>
			credentials.codex ? { accessToken: 'codex-secret', accountId: 'account-1' } : null,
		clearStoredSubscriptionCredential: () => {
			credentials.clears.push('anthropic')
			credentials.primary = false
		},
		clearStoredCodexCredential: () => {
			credentials.clears.push('codex')
			credentials.codex = false
		},
		clearAllStoredCredentials: () => {
			credentials.clears.push('all')
			credentials.primary = false
			credentials.codex = false
		},
	}
})

const { logoutCommand } = await import('../login.js')

function context() {
	const lines: string[] = []
	const ctx = {
		config: {},
		formatter: {
			name: 'text' as const,
			print: ({ text }: { text: string }) => lines.push(text),
			info: (message: string) => lines.push(message),
			error: ({ message }: { message: string }) => lines.push(message),
		},
	} satisfies CommandContext
	return { ctx, lines }
}

beforeEach(() => {
	credentials.primary = true
	credentials.codex = true
	credentials.clears.length = 0
})

describe('namzu logout provider routing', () => {
	it('removes only the selected Codex credential and keeps Claude', async () => {
		const { ctx, lines } = context()

		const code = await logoutCommand.handler({ ctx, rawArgs: ['codex'] })

		expect(code).toBe(EXIT_OK)
		expect(credentials).toMatchObject({ primary: true, codex: false, clears: ['codex'] })
		expect(lines.join('\n')).toContain("Removed Namzu's stored Codex")
		expect(lines.join('\n')).not.toContain('codex-secret')
	})

	it('keeps the argumentless shell command as an explicit all-store mutation', async () => {
		const { ctx } = context()

		const code = await logoutCommand.handler({ ctx, rawArgs: [] })

		expect(code).toBe(EXIT_OK)
		expect(credentials).toMatchObject({ primary: false, codex: false, clears: ['all'] })
	})

	it('refuses an unknown target before mutating either credential', async () => {
		const { ctx, lines } = context()

		const code = await logoutCommand.handler({ ctx, rawArgs: ['everything'] })

		expect(code).toBe(EXIT_USAGE)
		expect(credentials).toMatchObject({ primary: true, codex: true, clears: [] })
		expect(lines.join('\n')).toContain('namzu logout [claude|codex|all]')
	})
})
