import { describe, expect, it } from 'vitest'

import { kernelHostCommands } from '../kernel-commands.js'

/**
 * A command a host offers its operator is not runnable by the model unless it
 * says so. This keeps a new kernel command from being added without that
 * decision being made on purpose.
 */
describe('the kernel commands and the model', () => {
	const commands = kernelHostCommands({})

	it('declares a class on every command', () => {
		expect(commands.length).toBeGreaterThan(0)
		for (const command of commands) {
			expect(['run', 'confirm', 'never'], `/${command.name} has no modelRun class`).toContain(
				command.modelRun,
			)
		}
	})

	it('lets only the read form of /goal run unasked', () => {
		const goal = commands.find((command) => command.name === 'goal')
		expect(goal?.modelRun).toBe('confirm')
		expect(goal?.modelRunReads).toEqual(['', 'status'])
	})

	it('keeps the listing commands at run', () => {
		for (const name of ['skills', 'agents']) {
			expect(commands.find((command) => command.name === name)?.modelRun).toBe('run')
		}
	})
})
