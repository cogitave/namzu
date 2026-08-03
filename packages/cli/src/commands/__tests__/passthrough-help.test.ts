import { Command } from 'commander'
import { describe, expect, it } from 'vitest'

import { registerCommand } from '../registry.js'
import type { CommandContext, CommandDef } from '../types.js'

/**
 * `passThrough` turns commander's `--help` off so a command can parse it
 * itself. A command that does not then receives `--help` as INPUT: for
 * `run` it became the prompt to send to a model, for `history` the session
 * to search. A user asking how to use something got a credential error or
 * an empty result list.
 *
 * Three commands did this. The check lives in the registry rather than in
 * each of them, because that is what stops the fourth from doing it too.
 */

function harness(def: CommandDef) {
	const printed: string[] = []
	let exitCode: number | undefined

	const program = new Command().exitOverride().enablePositionalOptions()
	const ctx = {
		formatter: {
			name: 'text' as const,
			print: (data: unknown) => printed.push(String((data as { text?: string }).text ?? data)),
			info: () => {},
			error: () => {},
		},
		config: {},
	} as unknown as CommandContext

	registerCommand(program, def, {
		getContext: () => ctx,
		setExitCode: (code) => {
			exitCode = code
		},
	})

	return { program, printed, exit: () => exitCode }
}

const ran: string[] = []

const withHelp: CommandDef = {
	name: 'demo',
	description: 'demo',
	passThrough: true,
	help: 'Usage: namzu demo <thing>',
	handler: async ({ rawArgs }) => {
		ran.push(rawArgs.join(' '))
		return 0
	},
}

const withoutHelp: CommandDef = {
	name: 'owns-help',
	description: 'renders its own',
	passThrough: true,
	handler: async ({ rawArgs }) => {
		ran.push(rawArgs.join(' '))
		return 0
	},
}

describe('--help on a passThrough command', () => {
	it('prints the help instead of running the handler', async () => {
		ran.length = 0
		const h = harness(withHelp)
		await h.program.parseAsync(['demo', '--help'], { from: 'user' })

		expect(h.printed[0]).toContain('Usage: namzu demo')
		// The handler must not run: for `run` this was a model call with
		// `--help` as the prompt.
		expect(ran).toEqual([])
		expect(h.exit()).toBe(0)
	})

	it('accepts the short form too', async () => {
		ran.length = 0
		const h = harness(withHelp)
		await h.program.parseAsync(['demo', '-h'], { from: 'user' })
		expect(h.printed[0]).toContain('Usage:')
		expect(ran).toEqual([])
	})

	it('answers even when other arguments came first', async () => {
		// `namzu run some prompt --help` still means "how do I use this".
		ran.length = 0
		const h = harness(withHelp)
		await h.program.parseAsync(['demo', 'thing', '--help'], { from: 'user' })
		expect(ran).toEqual([])
	})

	it('leaves a command that renders its own help alone', async () => {
		// Intercepting here would mean that command's real help never shows.
		ran.length = 0
		const h = harness(withoutHelp)
		await h.program.parseAsync(['owns-help', '--help'], { from: 'user' })

		expect(h.printed).toEqual([])
		expect(ran).toEqual(['--help'])
	})

	it('does not intercept an ordinary invocation', async () => {
		ran.length = 0
		const h = harness(withHelp)
		await h.program.parseAsync(['demo', 'do', 'the', 'thing'], { from: 'user' })

		expect(ran).toEqual(['do the thing'])
		expect(h.printed).toEqual([])
	})
})
