import { describe, expect, it } from 'vitest'

import { builtInDoctorChecks } from '../index.js'
import { describePseudoTerminal, pseudoTerminalCheck } from '../terminal.js'

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
