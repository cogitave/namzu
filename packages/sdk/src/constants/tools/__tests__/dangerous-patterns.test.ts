import { describe, expect, it } from 'vitest'

import { DANGEROUS_PATTERNS } from '../index.js'

/**
 * `DANGEROUS_PATTERNS` is what `deny_dangerous_patterns` consults, and
 * `namzu run`'s own docstring promises that in a non-interactive run "the
 * safety gate still hard-denies catastrophic commands".
 *
 * The fork-bomb entry could not deny one. It was written `/:(){ :\|:& };:/`,
 * and in a regular expression `()` is an empty capture group rather than two
 * literal parentheses — so the pattern described `:{ :|:& };:`, a string that
 * is not valid shell and that nobody types. The list looked complete in review
 * and had a hole in it that only running the regex reveals.
 *
 * No test named a fork bomb before this one, which is how it survived.
 */

function denies(command: string): boolean {
	return DANGEROUS_PATTERNS.some((p) => p.test(command))
}

describe('the dangerous-command list denies fork bombs', () => {
	// Spelling varies with whitespace and with the function's name; the bomb
	// does not care, so neither may the pattern.
	it.each([
		':(){ :|:& };:',
		':(){:|:&};:',
		':() { :|:& }; :',
		':(){ : | : & }; :',
		'bomb(){ bomb|bomb& }; bomb',
		'f(){ f|f& };f',
	])('denies %j', (command) => {
		expect(denies(command)).toBe(true)
	})
})

describe('it does not deny ordinary shell', () => {
	// A function containing a pipe and a background job is not a fork bomb.
	// The signature is SELF-reference — the same name on both sides — and a
	// pattern that fired on the general shape would make the gate useless by
	// crying wolf.
	it.each([
		'build(){ make | tee log & }',
		'watch(){ tail -f log | grep ERROR & }; watch',
		'f(){ g|h& };f',
		'run(){ a|b& }; run',
		'git log | head -20',
		'npm test',
	])('allows %j', (command) => {
		expect(denies(command)).toBe(false)
	})
})

describe('the rest of the list still fires', () => {
	it.each(['rm -rf /', 'mkfs.ext4 /dev/sda', 'dd if=/dev/zero of=/dev/sda', 'sudo rm x'])(
		'denies %j',
		(command) => {
			expect(denies(command)).toBe(true)
		},
	)
})
