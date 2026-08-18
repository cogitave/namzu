import { describe, expect, it } from 'vitest'

import type { SlashContext } from '../slashCommands.js'
import { CLI_LOCAL_COMMANDS, parseSlash, runSlash } from '../slashCommands.js'

/**
 * Both of these commands can destroy something by being read too eagerly.
 *
 * A bare `/title` typed while deciding what to call something must ASK, not
 * clear — a name erased by an early enter is a loss nobody notices until
 * `/resume` is a list of opening messages again. And `/fork` must be the
 * command it says it is: a copy, leaving the original alone.
 */

function context(over: Partial<SlashContext> = {}): SlashContext {
	return {
		builtins: [],
		availableTools: () => [],
		sandbox: null,
		lastAssistantMessageId: () => null,
		providerSummary: 'a-provider',
		modelSummary: 'a-model',
		usage: null,
		instructionFiles: [],
		userCommands: [],
		permissions: {
			skipPermissions: false,
			rules: [],
			approvalLatched: () => false,
			neverPrompted: () => [],
		},
		...over,
	} as SlashContext
}

function run(input: string) {
	const parsed = parseSlash(input)
	if (!parsed) throw new Error(`not a slash command: ${input}`)
	return runSlash(input, context())
}

describe('/title', () => {
	it('asks rather than clears when given nothing', () => {
		// The load-bearing one. Reading a bare `/title` as "remove the name"
		// makes an accidental enter destructive, and the destroyed thing is
		// invisible until the next `/resume`.
		const action = run('/title')

		expect(action).toMatchObject({ kind: 'title', title: '', clear: false })
	})

	it('sets the name it was given, spaces and all', () => {
		expect(run('/title the auth refactor')).toMatchObject({
			kind: 'title',
			title: 'the auth refactor',
			clear: false,
		})
	})

	it('clears only on the literal word', () => {
		expect(run('/title clear')).toMatchObject({ kind: 'title', clear: true })
		expect(run('/title CLEAR')).toMatchObject({ kind: 'title', clear: true })
	})

	it('does not clear when "clear" is part of a longer name', () => {
		// `clear` is a word here, not a prefix. Someone naming a conversation
		// "clear the cache bug" means the name.
		expect(run('/title clear the cache bug')).toMatchObject({
			kind: 'title',
			title: 'clear the cache bug',
			clear: false,
		})
	})
})

describe('/fork', () => {
	it('is its own action rather than a message', () => {
		// It writes to the session store, and this command table is pure — so
		// the command decides and App performs, the way `/compact` and `/diff`
		// already do.
		expect(run('/fork')).toEqual({ kind: 'fork' })
	})

	it('says what it does to the original, where a person reads it', () => {
		// `/help` is the only place most people will learn what this does, and
		// "fork" alone does not say whether the original survives.
		const fork = CLI_LOCAL_COMMANDS.find((c) => c.name === 'fork')

		expect(fork?.description).toMatch(/leaving the original/i)
	})
})
