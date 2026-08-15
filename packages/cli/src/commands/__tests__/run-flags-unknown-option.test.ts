import { describe, expect, it } from 'vitest'

import { unknownOptionMessage } from '../run-flags.js'

/**
 * `namzu run "..." --verbose` is the order a person types, and the answer was
 * "pass `--` before a prompt that starts with a dash" — advice about a prompt
 * beginning with `-`, which sends the reader to the wrong half of their
 * command line. The flag is real and works; it is only positional.
 *
 * Found by running the CLI against a real provider. Every existing flag test
 * passes the option in the position that already worked, so none of them could
 * see this.
 */
describe('a refusal that names the actual fix', () => {
	it('tells a misplaced global option where it goes', () => {
		// Reverting to the single generic sentence fails this.
		const message = unknownOptionMessage(['--verbose'])

		expect(message).toContain('global option')
		expect(message).toContain('namzu --verbose <command>')
		expect(message, 'still blaming a leading dash').not.toContain('starts with a dash')
	})

	it('keeps the dash advice for an option that really is unknown', () => {
		// The negative half: replacing the generic branch outright would lose
		// the case it was written for.
		const message = unknownOptionMessage(['--not-a-real-flag'])

		expect(message).toContain('unknown option(s)')
		expect(message).toContain('starts with a dash')
	})

	it('handles --log-format=json, where the value is glued to the name', () => {
		// Splitting on `=` is what makes this match; dropping the split fails
		// here and nowhere else.
		const message = unknownOptionMessage(['--log-format=json'])

		expect(message).toContain('global option')
	})

	it('names every misplaced option, not just the first', () => {
		const message = unknownOptionMessage(['--verbose', '--log-format'])

		expect(message).toContain('--verbose')
		expect(message).toContain('--log-format')
		expect(message).toContain('are global options')
	})
})
