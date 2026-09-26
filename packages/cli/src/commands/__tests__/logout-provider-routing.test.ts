import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from '../../exit-codes.js'
import type { CommandContext } from '../types.js'

const credentials = vi.hoisted(() => ({
	primary: true,
	codex: true,
	googleKey: true,
	failSubscriptions: false,
	clears: [] as string[],
}))

vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		credentialsPath: () => '/device/.namzu/credentials.json',
		googleApiKeyPath: () => '/device/.namzu/gemini-api-key.json',
		readStoredSubscriptionCredential: () =>
			credentials.primary ? { accessToken: 'claude-secret' } : null,
		readStoredCodexCredential: () =>
			credentials.codex ? { accessToken: 'codex-secret', accountId: 'account-1' } : null,
		readStoredGeminiApiKey: () => (credentials.googleKey ? 'gemini-secret' : null),
		clearStoredSubscriptionCredential: () => {
			credentials.clears.push('anthropic')
			credentials.primary = false
		},
		clearStoredCodexCredential: () => {
			credentials.clears.push('codex')
			credentials.codex = false
		},
		clearStoredGeminiApiKey: () => {
			credentials.clears.push('gemini')
			credentials.googleKey = false
		},
		clearAllStoredCredentials: () => {
			credentials.clears.push('all')
			if (credentials.failSubscriptions) throw new Error('subscription lock held')
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
	credentials.googleKey = true
	credentials.failSubscriptions = false
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
		expect(credentials).toMatchObject({
			primary: false,
			codex: false,
			googleKey: false,
			clears: ['all', 'gemini'],
		})
	})

	it('removes only the saved Gemini API key', async () => {
		const { ctx, lines } = context()
		const code = await logoutCommand.handler({ ctx, rawArgs: ['gemini'] })
		expect(code).toBe(EXIT_OK)
		expect(credentials).toMatchObject({
			primary: true,
			codex: true,
			googleKey: false,
			clears: ['gemini'],
		})
		expect(lines.join('\n')).toContain("Removed Namzu's saved Gemini API key")
		expect(lines.join('\n')).not.toContain('gemini-secret')
	})

	it('reports a partial all-store failure and still tries the Gemini store', async () => {
		credentials.failSubscriptions = true
		const { ctx, lines } = context()
		const code = await logoutCommand.handler({ ctx, rawArgs: ['all'] })
		expect(code).toBe(EXIT_FAIL)
		expect(credentials).toMatchObject({
			primary: true,
			codex: true,
			googleKey: false,
			clears: ['all', 'gemini'],
		})
		expect(lines.join('\n')).toContain('Some stored credentials could not be removed')
		expect(lines.join('\n')).not.toContain("Removed Namzu's stored credentials")
	})

	it('refuses an unknown target before mutating either credential', async () => {
		const { ctx, lines } = context()

		const code = await logoutCommand.handler({ ctx, rawArgs: ['everything'] })

		expect(code).toBe(EXIT_USAGE)
		expect(credentials).toMatchObject({ primary: true, codex: true, googleKey: true, clears: [] })
		expect(lines.join('\n')).toContain('namzu logout [claude|codex|gemini|all]')
	})
})
