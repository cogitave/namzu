import { describe, expect, it } from 'vitest'

import { decodedCommands, decomposeCommandLine, writesThroughRedirection } from '../command-line.js'

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

	it('reads a quoted -c as the flag, because bash removes the quotes first', () => {
		// Missing. This case used to assert the opposite, reasoning from
		// `echo "-c"`. But the quotes are gone before bash reads its options:
		// `bash "-c" "git push"` runs `git push`, and a deny rule for it must
		// see it.
		const { segments } = decomposeCommandLine('bash "-c" "git push"')
		expect(segments).toEqual(['bash "-c" "git push"', 'git push'])
	})

	it('does not read -c as a flag once the first operand has been seen', () => {
		// Invention. `bash script -c x` runs `script` with two arguments.
		expect(decomposeCommandLine('bash script -c "git push"').segments).toEqual([
			'bash script -c "git push"',
		])
	})

	it('reads clustered and long options before -c', () => {
		expect(decomposeCommandLine('bash -lc "git push"').segments).toContain('git push')
		expect(decomposeCommandLine('bash -o pipefail -c "git push"').segments).toContain('git push')
		expect(decomposeCommandLine('bash --norc -c "git push"').segments).toContain('git push')
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
		['diff <(a) <(b)', 'process substitution'],
		['eval "$CMD"', 'runtime evaluation'],
	])('marks %s opaque (%s)', (command) => {
		expect(decomposeCommandLine(command).opaque).toBe(true)
	})

	it.each([
		['echo $(whoami)', 'command substitution'],
		['echo `whoami`', 'backticks'],
		['echo "$(whoami)"', 'substitution inside double quotes'],
	])('reads %s instead of marking it opaque (%s)', (command) => {
		// `$(…)`/backtick content is read as a nested command line and its
		// own commands are in `segments` for deny, the same as `diff <(a)
		// <(b)` (still opaque, out of this scope) shows above for a
		// construct the reader does not model at all.
		const result = decomposeCommandLine(command)
		expect(result.opaque).toBe(false)
		expect(result.segments).toContain('whoami')
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
		// decision that fails dangerously when it stops matching. `<(…)`
		// process substitution is left opaque (out of scope, unlike `$(…)`).
		const { segments, opaque } = decomposeCommandLine('diff <(date) && git push')
		expect(opaque).toBe(true)
		expect(segments).toContain('git push')
	})

	it('a command substitution beside && does not withdraw either side from deny', () => {
		const { segments, opaque } = decomposeCommandLine('echo $(date) && git push')
		expect(opaque).toBe(false)
		expect(segments).toContain('git push')
		expect(segments).toContain('date')
	})
})

describe("ANSI-C quoting, `$'…'`", () => {
	// Inside `$'…'` a backslash escapes the quote, so `$'\\''` is ONE quoted
	// apostrophe. A walker that reads it as a closed quote and an open one
	// takes the rest of the line for quoted text while the shell runs it.
	it('sees the command after an escaped quote (missing)', () => {
		// The segment used to keep the trailing `#'`. It is a comment, and bash
		// does not pass it to `touch`.
		const { segments, opaque } = decomposeCommandLine("git status $'\\'' ; touch pwned #'")
		expect(segments).toEqual(["git status $'\\''", 'touch pwned'])
		// The quote is decoded now, so it no longer hides anything.
		expect(opaque).toBe(false)
	})

	it('keeps a separator inside the quote inside its command (inventing)', () => {
		const { segments } = decomposeCommandLine("echo $'a \\' ; b' && git push")
		expect(segments).toEqual(["echo $'a \\' ; b'", 'git push'])
	})

	it('decodes an ANSI-C quote instead of treating it as opaque', () => {
		// This used to be opaque because the escapes were not decoded. They
		// are: `$'\x3b'` is the argument `;`, one command.
		expect(decomposeCommandLine("echo $'\\x3b'")).toEqual({
			segments: ["echo $'\\x3b'"],
			opaque: false,
		})
		expect(decodedCommands("echo $'\\x3b' $'\\101\\u0042\\cC'")).toEqual(['echo ; AB\x03'])
		// Inside single or double quotes `$'` is literal text.
		expect(decomposeCommandLine("grep 'a$' f").opaque).toBe(false)
		expect(decomposeCommandLine('echo "$\'"').opaque).toBe(false)
	})

	it('reads `$$` as the PID, not the start of an ANSI-C quote', () => {
		// The comment after the command is not part of it.
		expect(decomposeCommandLine("echo $$'\\' ; git push origin main #'").segments).toContain(
			'git push origin main',
		)
		expect(decomposeCommandLine("echo $$$'\\'' ; git push origin main #'").segments).toContain(
			'git push origin main',
		)
		expect(writesThroughRedirection("echo $$'\\' > ~/.bashrc #'")).toBe(true)
	})

	it('reads a nested shell payload written in ANSI-C quotes', () => {
		expect(decomposeCommandLine("bash -c $'git push'").segments).toContain('git push')
	})

	it('finds a redirection after an escaped quote', () => {
		expect(writesThroughRedirection("git status $'\\'' > ~/.bashrc #'")).toBe(true)
		expect(writesThroughRedirection("a $'>' b")).toBe(false)
		// Decoded now: the target is `/dev/null`, which is not a write. It
		// counted as one while the escapes were left undecoded.
		expect(writesThroughRedirection("a > $'/dev/nul\\x6c'")).toBe(false)
		expect(writesThroughRedirection("a > $'/etc/passw\\x64'")).toBe(true)
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

describe('writesThroughRedirection', () => {
	it('sees every operator that opens a file for writing', () => {
		for (const line of [
			'a > f',
			'a>>f',
			'a >| f',
			'a &> f',
			'a &>>f',
			'a >&f',
			'a 1>f',
			'a <> f',
			'a >(b)',
			'a >',
		])
			expect(writesThroughRedirection(line), line).toBe(true)
	})

	it('does not count /dev/null, descriptor duplication or quoted text', () => {
		for (const line of [
			'a',
			'a 2>/dev/null',
			'a >/dev/null 2>&1',
			'a >&2',
			'a 3>&-',
			"a '>' b",
			'a ">f"',
			'a \\> f',
		])
			expect(writesThroughRedirection(line), line).toBe(false)
	})

	it('counts a target it cannot read as a write', () => {
		expect(writesThroughRedirection('a > "$OUT"')).toBe(true)
		expect(writesThroughRedirection('a > "unterminated')).toBe(true)
	})
})
