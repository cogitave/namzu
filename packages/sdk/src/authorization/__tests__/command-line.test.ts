import { describe, expect, it } from 'vitest'

import { decomposeCommandLine } from '../command-line.js'

/**
 * Two failures, and they are opposites.
 *
 * MISSING a command is the one that motivated the module: a segment that runs
 * and does not appear here is a command no deny rule can see. INVENTING one is
 * just as bad in the other direction, because an allow rule requires every
 * segment to match, so a segment that does not exist withdraws a permission
 * nobody withdrew — and it does it for a reason the operator cannot read off
 * their own config.
 *
 * So each case below names which of the two it is written against.
 */

describe('the plain case stays plain', () => {
	it('returns a chainless command byte for byte', () => {
		// Load-bearing. Most values a pattern rule tests are not command lines
		// at all — a path, a URL, a number — and this is what keeps every one of
		// those rules deciding exactly what it decided before.
		const original = '  git push origin main  '
		expect(decomposeCommandLine(original)).toEqual({ segments: [original], opaque: false })
	})

	it('does not treat a path with brackets as a group to strip', () => {
		// Invention. The bracket-stripping exists for `(cd x && make)`, and a
		// value that never split must not be reshaped by it.
		const path = '(draft) notes.ts'
		expect(decomposeCommandLine(path).segments).toEqual([path])
	})
})

describe('separators', () => {
	it.each([
		['echo hi && git push', 'and'],
		['echo hi || git push', 'or'],
		['echo hi ; git push', 'semicolon'],
		['echo hi | git push', 'pipe'],
		['echo hi & git push', 'background'],
		['echo hi\ngit push', 'newline'],
	])('cuts %s (%s)', (command) => {
		expect(decomposeCommandLine(command).segments).toEqual(['echo hi', 'git push'])
	})

	it('strips the brackets a subshell leaves on its segments', () => {
		// Missing. `^make` does not match `make)`, so without this the deny that
		// motivated the module fails on the most ordinary grouping in shell.
		expect(decomposeCommandLine('(cd build && make)').segments).toEqual(['cd build', 'make'])
	})
})

describe('what looks like a separator and is not', () => {
	it('keeps a quoted separator inside its command', () => {
		// Invention, and the reason this is a walk rather than a split. The line
		// runs one command that prints a literal.
		expect(decomposeCommandLine('echo "a && b"').segments).toEqual(['echo "a && b"'])
	})

	it('keeps a single-quoted separator, where nothing else is live either', () => {
		expect(decomposeCommandLine("echo 'a; b'").segments).toEqual(["echo 'a; b'"])
	})

	it('keeps an escaped separator', () => {
		expect(decomposeCommandLine('echo a \\&\\& b').segments).toEqual(['echo a \\&\\& b'])
	})

	it.each(['echo a 2>&1', 'echo a &>log', 'echo a >&2'])(
		'keeps the redirection in %s',
		(command) => {
			// Invention, and the one that would have been most confusing in the
			// field: splitting `2>&1` manufactures a segment named `1`, which no
			// allow rule matches, so redirecting output would quietly cost a command
			// its approval.
			expect(decomposeCommandLine(command).segments).toEqual([command])
		},
	)
})

describe('a nested shell', () => {
	it('looks inside a -c payload, which carries no separator of its own', () => {
		// Missing. `bash -c "git push"` is a single unchained segment, so every
		// check above this one would have passed it through untouched.
		const { segments } = decomposeCommandLine('bash -c "git push origin main"')
		expect(segments).toContain('git push origin main')
	})

	it('keeps the invocation as well, so a rule about the shell still fires', () => {
		const { segments } = decomposeCommandLine('bash -c "git push"')
		expect(segments[0]).toBe('bash -c "git push"')
	})

	it('reads a payload that itself chains', () => {
		const { segments } = decomposeCommandLine('sh -c "echo hi && git push"')
		expect(segments).toContain('echo hi')
		expect(segments).toContain('git push')
	})

	it('matches on the basename, so an absolute path is the same shell', () => {
		expect(decomposeCommandLine('/bin/bash -c "git push"').segments).toContain('git push')
	})

	it('does not read a quoted -c as the flag', () => {
		// Invention. `echo "-c" "git push"` runs one command and prints two
		// words; decomposing the second would report a command that never runs.
		const { segments } = decomposeCommandLine('bash "-c" "git push"')
		expect(segments).toEqual(['bash "-c" "git push"'])
	})

	it('is opaque when -c has no payload to read', () => {
		// The honest answer to "there is a nested command and I cannot see it".
		expect(decomposeCommandLine('bash -c').opaque).toBe(true)
	})

	it('stops at a depth limit rather than reporting a partial list as whole', () => {
		// Built rather than written out: each level has to escape the level
		// inside it, and a hand-typed version of this string is a test of my
		// escaping instead of a test of the limit.
		let deep = 'git push'
		for (let level = 0; level < 6; level += 1) {
			deep = `bash -c "${deep.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
		}
		expect(decomposeCommandLine(deep).opaque).toBe(true)
	})

	it('reads a payload escaped inside its enclosing quotes', () => {
		// The tokenizer treated a backslash inside double quotes as a literal,
		// so `\"` closed the string early and the nested command was read as
		// two truncated words. Found by the depth test above, which could not
		// build its input without hitting it.
		const { segments } = decomposeCommandLine('bash -c "bash -c \\"git push\\""')
		expect(segments).toContain('git push')
	})
})

describe('opacity', () => {
	it.each([
		['echo $(whoami)', 'command substitution'],
		['echo `whoami`', 'backticks'],
		['diff <(a) <(b)', 'process substitution'],
		['echo "$(whoami)"', 'substitution inside double quotes'],
		['eval "$CMD"', 'runtime evaluation'],
	])('marks %s opaque (%s)', (command) => {
		expect(decomposeCommandLine(command).opaque).toBe(true)
	})

	it('does not mark single-quoted substitution, where nothing expands', () => {
		// Invention, of a sort: a false opacity silently withdraws every allow
		// rule from a command that runs exactly what it says.
		expect(decomposeCommandLine("echo '$(whoami)'").opaque).toBe(false)
	})

	it('marks an unterminated quote opaque instead of guessing', () => {
		// What the line runs is not what this walk saw, and the caller must not
		// be told otherwise.
		expect(decomposeCommandLine('echo "unterminated && git push').opaque).toBe(true)
	})

	it('still reports the segments it could see when opaque', () => {
		// Opacity withdraws `allow`; it must not also blind `deny`, which is the
		// decision that fails dangerously when it stops matching.
		const { segments, opaque } = decomposeCommandLine('echo $(date) && git push')
		expect(opaque).toBe(true)
		expect(segments).toContain('git push')
	})
})

describe('it never returns nothing', () => {
	it.each(['', '   ', '&&', ';;'])('keeps %p rather than emptying it', (command) => {
		// An empty list would make `every` vacuously true, turning a line with
		// no readable command into an allow. That is the single worst output
		// this function could produce.
		expect(decomposeCommandLine(command).segments.length).toBeGreaterThan(0)
	})
})
