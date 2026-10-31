import { afterEach, describe, expect, it, vi } from 'vitest'

import { FakePty } from '../../../terminal/__tests__/support/fake-pty.js'
import { builtInDoctorChecks } from '../index.js'
import { describePseudoTerminal, pseudoTerminalCheck, tryOneSession } from '../terminal.js'

const binding = {} as never

describe('the pseudo-terminal row', () => {
	it('passes when a program can be run in one', async () => {
		const result = await describePseudoTerminal(
			async () => binding,
			async () => {},
		)
		expect(result.status).toBe('pass')
		expect(result.message).toContain('namzu spaces')
	})

	it('warns, with how to get one, when the component does not load', async () => {
		const result = await describePseudoTerminal(async () => {
			throw new Error('Cannot find module node-pty\nrequire stack')
		})
		expect(result.status).toBe('warn')
		expect(result.message).toContain('Cannot find module node-pty')
		expect(result.message).not.toContain('require stack')
		expect(result.message).toContain('starts a single session instead')
		expect(result.remediation).toContain('without --omit=optional')
	})

	it('warns when it loads but a program cannot be run', async () => {
		const result = await describePseudoTerminal(
			async () => binding,
			async () => {
				throw new Error('posix_spawnp failed')
			},
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('posix_spawnp failed')
	})

	it('is one of the built-in checks', () => {
		expect(builtInDoctorChecks).toContain(pseudoTerminalCheck)
	})
})

describe('the pseudo-terminal probe', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('gives up on a program that never ends, and ends it', async () => {
		vi.useFakeTimers()
		const pty = new FakePty(1, 'node', [], {} as never)
		const attempt = tryOneSession({ spawn: () => pty } as never, 5000)
		const outcome = expect(attempt).rejects.toThrow('did not finish in time')
		await vi.advanceTimersByTimeAsync(5000)
		await outcome
		expect(pty.kills).toHaveLength(1)
	})

	it('ends the program after a normal exit too', async () => {
		const pty = new FakePty(1, 'node', [], {} as never)
		const attempt = tryOneSession({ spawn: () => pty } as never)
		pty.end(0)
		await attempt
		expect(pty.kills).toHaveLength(1)
	})
})
