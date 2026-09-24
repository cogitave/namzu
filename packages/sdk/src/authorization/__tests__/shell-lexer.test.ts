import { describe, expect, it } from 'vitest'

import {
	type ShellCommand,
	type ShellLexResult,
	lexShellCommandLine,
	nestedShellCommand,
} from '../shell-lexer.js'

/**
 * What the lexer says a line runs. Each case here is a rule of bash's that
 * some earlier reader of command lines got wrong, or one the differential
 * check against real bash (`shell-lexer-bash.test.ts`) found.
 */

/** The top-level commands' words, with `~` marking a word that expands at runtime. */
function words(line: string, result: ShellLexResult = lexShellCommandLine(line)): string[][] {
	return result.commands
		.filter((command) => command.origin === 'line')
		.map((command) => command.words.map((word) => (word.expands ? `~${word.value}` : word.value)))
}

function commands(line: string): readonly ShellCommand[] {
	return lexShellCommandLine(line).commands
}

describe('quoting', () => {
	it.each([
		["a 'b c' d", [['a', 'b c', 'd']]],
		['a "b c" d', [['a', 'b c', 'd']]],
		['a b\\ c', [['a', 'b c']]],
		['a "\\$ \\` \\" \\\\ \\a"', [['a', '$ ` " \\ \\a']]],
		["a 'x\\'", [['a', 'x\\']]],
		['a\\;b', [['a;b']]],
		['a \\\n b', [['a', 'b']]],
		['a\\\nb', [['ab']]],
		['a "x\\\ny"', [['a', 'xy']]],
		["a 'x\\\ny'", [['a', 'x\\\ny']]],
		['a x\\', [['a', 'x\\']]],
		['a ""', [['a', '']]],
	])('%j', (line, expected) => {
		expect(words(line)).toEqual(expected)
	})

	it('decodes ANSI-C quotes, escapes and all', () => {
		expect(
			words("a $'\\x3b' $'\\101\\x42\\u0043' $'\\n\\t\\\\\\'\\\"\\?' $'\\cA\\c?' $'\\e\\z'"),
		).toEqual([['a', ';', 'ABC', '\n\t\\\'"?', '\x01\x7f', '\x1b\\z']])
		// `\x{…}` takes any number of digits and keeps the low byte.
		expect(words("a $'\\x{41}' $'\\x{4142}z'")).toEqual([['a', 'A', 'Bz']])
	})

	it('flags an ANSI-C escape whose value depends on the locale or truncates the word', () => {
		expect(words("a $'\\xe9' $'\\u00e9' $'b\\0c'")).toEqual([['a', '~\xe9', '~é', '~b\x00c']])
	})

	it('reads $$ as the PID before looking for an ANSI-C quote', () => {
		// `$$'…'` is the PID followed by a plain single quote, in which a
		// backslash is literal, so the quote closes at the next apostrophe.
		expect(words("echo $$'\\' ; git push #'")).toEqual([
			['echo', '~$$\\'],
			['git', 'push'],
		])
	})

	it('treats $"…" as a translated string, which expands at runtime', () => {
		expect(words('a $"b c"')).toEqual([['a', '~$"b c"']])
	})

	it('keeps a quoted separator inside its word', () => {
		expect(words('echo \'a; b\' "c && d" e\\|f')).toEqual([['echo', 'a; b', 'c && d', 'e|f']])
	})
})

describe('expansion flags', () => {
	it.each([
		['a $b', '$b'],
		['a ${b:-c}', '${b:-c}'],
		['a $1', '$1'],
		['a $@', '$@'],
		['a *', '*'],
		['a b?', 'b?'],
		['a [bc]', '[bc]'],
		['a {b,c}', '{b,c}'],
		['a {1..3}', '{1..3}'],
		['a ~', '~'],
		['a ~/x', '~/x'],
		['a x=~/y', 'x=~/y'],
		['a $((1+2))', '$((1+2))'],
	])('%s', (line, word) => {
		expect(words(line)).toEqual([['a', `~${word}`]])
	})

	it.each(['a {b}', 'a b~', "a '*'", 'a "~"', 'a \\$b', "a '$b'", 'a $', 'a "$"', 'a b$'])(
		'does not flag %s',
		(line) => {
			const word = commands(line)[0]?.words[1]
			expect(word?.expands).toBe(false)
		},
	)
})

describe('control operators', () => {
	it.each([';', '&', '&&', '||', '|', '|&', '\n'])('separates on %j', (op) => {
		expect(words(`a ${op} b`)).toEqual([['a'], ['b']])
	})

	it('keeps redirections with descriptors inside the command', () => {
		const [command] = commands('a 2>&1 >&2 &>f 3<&- {fd}>g')
		expect(command?.words.map((word) => word.value)).toEqual(['a'])
		expect(command?.redirections.map((r) => `${r.fd ?? ''}${r.operator}${r.target.value}`)).toEqual(
			['2>&1', '>&2', '&>f', '3<&-', '{fd}>g'],
		)
	})

	it('reads a `-` after `<&` or `>&` as a token of its own', () => {
		// `3<&-a` closes descriptor 3, and `a` is the next word.
		expect(words('b 3<&-a')).toEqual([['b', 'a']])
	})

	it('reads a word joined by a line continuation as bash does', () => {
		// The continuation is gone before bash classifies the word, so this is
		// an assignment and a descriptor, not a command and a word.
		const [assigned] = commands('fi\\\nb=ab c')
		expect(assigned?.assignments).toBe(1)
		const [redirected] = commands('a 2\\\n>f')
		expect(redirected?.redirections[0]?.fd).toBe('2')
	})

	it('ends a word at a comment only at a word boundary', () => {
		expect(words('a#b c # d ; e\nf')).toEqual([['a#b', 'c'], ['f']])
	})

	it('drops a trailing backslash when the last line was read inside a single quote', () => {
		// Bash appends a newline to the last line of a string unless it ends
		// in a backslash and was read outside single quotes.
		expect(words("a 'x\ny'\\")).toEqual([['a', 'x\ny']])
		expect(words("a 'x\ny'\nb\\")).toEqual([['a', 'x\ny'], ['b\\']])
	})
})

describe('reserved words and compound commands', () => {
	it.each([
		['if a; then b; elif c; then d; else e; fi', [['a'], ['b'], ['c'], ['d'], ['e']]],
		['while a; do b; done', [['a'], ['b']]],
		['until a; do b; done', [['a'], ['b']]],
		['for x in a b; do c; done', [['c']]],
		['for x do c; done', [['c']]],
		['for x in a; { c; }', [['c']]],
		['case a in (b|c) d;; e) f;& *) g;;& esac', [['d'], ['f'], ['g']]],
		['{ a; b; }', [['a'], ['b']]],
		['(a; b)', [['a'], ['b']]],
		['! a | b', [['a'], ['b']]],
		['time -p a', [['a']]],
		['a | time b', [['a'], ['time', 'b']]],
		['x=1 if', [['x=1', 'if']]],
		['a if then', [['a', 'if', 'then']]],
	])('%j', (line, expected) => {
		const result = lexShellCommandLine(line)
		expect(result.complete).toBe(true)
		expect(words(line, result)).toEqual(expected)
	})

	it('records a compound command’s redirections', () => {
		const result = lexShellCommandLine('{ a; } > f')
		expect(result.redirections.map((r) => r.target.value)).toEqual(['f'])
	})

	it.each([
		'a ;; b',
		'a & ; b',
		'; a',
		'a |',
		'a &&',
		'( )',
		'{ a }',
		'a (',
		')',
		'a | ! b',
		'! && b',
		'in a',
		']] a',
		'if a; then b',
		'case a in esac) b;; esac',
		'>a &>>b= c',
	])('reads %j as a syntax error, which is opaque', (line) => {
		const result = lexShellCommandLine(line)
		expect(result.complete).toBe(false)
		expect(result.opaque).toBe(true)
	})

	it('reads a subscript as one word only where an assignment may stand', () => {
		expect(words('a[x y] b')).toEqual([['~a[x y]', 'b']])
		expect(words('b a[x y]')).toEqual([['b', '~a[x', 'y]']])
	})

	it('reads an array assignment', () => {
		expect(words('x=(a b) c')).toEqual([['~x=(a b)', 'c']])
		expect(lexShellCommandLine('echo x=(a)').complete).toBe(false)
	})
})

describe('here-documents', () => {
	it('consumes the body, which is never a command', () => {
		expect(words('cat <<EOF\ngit push\nEOF\nb')).toEqual([['cat'], ['b']])
		expect(words("cat <<'EOF' ; a\n$(x)\nEOF\nb")).toEqual([['cat'], ['a'], ['b']])
		expect(words('cat <<-EOF\n\tx\n\tEOF\nb')).toEqual([['cat'], ['b']])
		expect(words('cat <<A <<B\nx\nA\ny\nB\nc')).toEqual([['cat'], ['c']])
	})

	it('joins an unquoted body’s escaped newline before looking for the delimiter', () => {
		expect(words('cat <<EOF\nx\\\nEOF\nEOF\nb')).toEqual([['cat'], ['b']])
		expect(words('cat <<EOF\nx\\\\\nEOF\nb')).toEqual([['cat'], ['b']])
	})

	it('runs to the end when the delimiter never comes', () => {
		expect(words('cat <<EOF\na\nb')).toEqual([['cat']])
	})

	it('reads an unquoted body’s substitution as a nested command, and does not run one in a quoted body', () => {
		const unquoted = lexShellCommandLine('cat <<EOF\n$(x)\nEOF')
		expect(unquoted.opaque).toBe(false)
		expect(unquoted.commands.map((c) => c.words[0]?.value)).toEqual(['x', 'cat'])
		expect(lexShellCommandLine("cat <<'EOF'\n$(x)\nEOF").opaque).toBe(false)
	})
})

describe('words outside simple commands', () => {
	it('reports a for loop’s variable and list, and a case statement’s subject and patterns', () => {
		const result = lexShellCommandLine(
			'for d in ~/x \'a b\'; do rm -r "$d"; done; case $p in a|b*) :;; esac',
		)
		expect(result.compoundWords.map((w) => (w.expands ? `~${w.value}` : w.value))).toEqual([
			'd',
			'~~/x',
			'a b',
			'~$p',
			'a',
			'~b*',
		])
	})

	it('reports a here-document’s body, up to its delimiter line', () => {
		const result = lexShellCommandLine("bash <<'EOF' && cat <<-E\nrm x\n$(y)\nEOF\n\tz\n\tE\n")
		expect(result.redirections.map((r) => r.body)).toEqual(['rm x\n$(y)\n', '\tz\n'])
		expect(lexShellCommandLine('cat <<EOF\nno end').redirections[0]?.body).toBe('no end')
		expect(lexShellCommandLine('cat < f').redirections[0]?.body).toBeUndefined()
	})
})

describe('nested shells', () => {
	it.each([
		'bash -c "git push"',
		"sh -c 'git push'",
		"bash -c $'git\\x20push'",
		'bash "-c" "git push"',
		'/bin/bash -lc "git push"',
		'bash -o pipefail -c "git push"',
		'bash --norc -c "git push" name arg',
		'bash -c -- "git push"',
		'busybox sh -c "git push"',
	])('reads the payload of %j', (line) => {
		const nested = commands(line).filter((command) => command.origin === 'shell')
		expect(nested.map((command) => command.words.map((word) => word.value))).toEqual([
			['git', 'push'],
		])
	})

	it('does not read an operand after the first as a payload', () => {
		expect(commands('bash script -c "git push"').filter((c) => c.origin === 'shell')).toEqual([])
	})

	it('is opaque when the payload is missing or expands', () => {
		expect(lexShellCommandLine('bash -c').opaque).toBe(true)
		expect(lexShellCommandLine('bash -c "$CMD"').opaque).toBe(true)
	})

	it('stops at a depth limit', () => {
		let line = 'git push'
		for (let level = 0; level < 6; level += 1) line = `bash -c ${JSON.stringify(line)}`
		expect(lexShellCommandLine(line).reasons).toContain('nested shells too deep')
	})

	// A host that decides on this reading must know which text it already
	// holds: the scheduled-run floor took any shell at the head with `-c` as
	// read, and `powershell -c 'namzu schedule stop'` was read by nobody.
	describe('nestedShellCommand says which payloads the reading holds', () => {
		const payload = (line: string) => {
			const command = lexShellCommandLine(line).commands[0] as ShellCommand
			const nested = nestedShellCommand(command.words.slice(command.assignments))
			return nested === null ? null : 'payload' in nested ? nested.payload.value : nested
		}

		it.each([
			'bash -c "git push"',
			'/bin/bash -lc "git push"',
			'bash -o pipefail -c "git push"',
			'bash -c -- "git push"',
			'busybox sh -c "git push"',
			'A=1 sh -c "git push"',
		])('the payload of %j', (line) => {
			expect(payload(line)).toBe('git push')
		})

		it.each([
			"powershell -c 'git push'",
			"pwsh -command 'git push'",
			"fish -c 'git push'",
			"tcsh -c 'git push'",
			"bash.exe -c 'git push'",
			"BASH -c 'git push'",
			"bash script -c 'git push'",
			"busybox fish -c 'git push'",
			'bash',
		])('none for %j, which the reading does not hold', (line) => {
			expect(payload(line)).toBeNull()
			expect(lexShellCommandLine(line).commands.filter((c) => c.origin === 'shell')).toEqual([])
		})

		it('says why when the reading is opaque instead', () => {
			expect(payload('bash -c "$CMD"')).toEqual({ opaque: 'nested shell option' })
			expect(payload('bash -c -- "$CMD"')).toEqual({
				opaque: 'nested shell command is expanded at runtime',
			})
			expect(payload('bash -c')).toEqual({ opaque: 'nested shell without a command' })
			expect(payload('bash $OPT -c x')).toEqual({ opaque: 'nested shell option' })
		})
	})
})

describe('opacity', () => {
	it.each([
		['a ${ b; }', 'command substitution'],
		['a <(b)', 'process substitution'],
		['a ${x:-<(b)}', 'process substitution'],
		['a[<(b)]', 'process substitution'],
		["x >&2'$(b)'", 'quoted or expanding target of >& or <&'],
		["x >&2${v:-'$(b)'}", 'quoted or expanding target of >& or <&'],
		['a >(b)', 'process substitution'],
		['a $((x))', 'arithmetic'],
		['((x)) && a', 'arithmetic'],
		['a ${!x}', 'parameter expansion'],
		['a ${x[i]}', 'parameter expansion'],
		['a ${x:i}', 'parameter expansion'],
		['[[ -f x ]] && a', 'conditional expression'],
		['f() { a; }', 'function definition'],
		['coproc a', 'coproc'],
		// POSIX mode, which is bash as `/bin/sh`, runs the command `time` here.
		['time -p a', 'time with an option'],
		['shopt -s extglob\na', 'parser setting'],
		['set -o posix; a', 'parser setting'],
		['POSIXLY_CORRECT=1 a', 'parser setting'],
		['a "unterminated', 'unterminated quote'],
	])('%j (%s)', (line, reason) => {
		const result = lexShellCommandLine(line)
		expect(result.opaque).toBe(true)
		expect(result.reasons).toContain(reason)
	})

	it('records the commands a substitution runs, for deny', () => {
		expect(
			commands('a $(git push) "`rm x`"').map((c) => [
				c.origin,
				c.words.map((w) => w.value).join(' '),
			]),
		).toEqual([
			['substitution', 'git push'],
			['substitution', 'rm x'],
			['line', 'a $(git push) `rm x`'],
		])
	})

	it('is opaque where bash’s expander re-reads `$$` differently from its parser', () => {
		// Measured: bash runs `b` here. Its parser pairs the dollars and
		// ends the double quote early, so `'$(b)'` looks single-quoted; its
		// expander reads `${x:-"'$(b)'"}` and runs the substitution.
		const result = lexShellCommandLine(`a "$\${x:-"'$(b)'"}"`)
		expect(result.opaque).toBe(true)
	})

	it.each([
		'a $((1 + 2))',
		'a ${x:-y} ${#x} ${x%.*} ${x/a/b} ${x:1:2}',
		"a '$(b)'",
		'set -euo pipefail; a',
	])('leaves %j transparent', (line) => {
		expect(lexShellCommandLine(line).opaque).toBe(false)
	})
})

describe('cost', () => {
	/**
	 * Bash's grammar invites re-reading (`((` is tried as arithmetic, then
	 * as two subshells), and every re-read is bounded, so the work stays
	 * linear in the input. The lines are 200 KB of the shapes that would
	 * otherwise be quadratic or exhaust the stack.
	 */
	const size = 200_000
	const fill = (unit: string, length = size): string =>
		unit.repeat(Math.ceil(length / unit.length)).slice(0, length)
	const shapes = [
		'(',
		'((',
		'$(',
		'$((',
		'${x:-',
		'"${x:-',
		'`\\',
		'\\',
		"'",
		'a;',
		'a|',
		"$'\\x3b'",
		'a <<a\n',
		'a <<a ',
		'{ ',
		'if ',
		'x[',
		'x=(',
		'\\\n',
		'$$',
		'"$$(',
		'bash -c "',
		'<(',
		'2>&1 ',
	]

	it.each(shapes)('reads 200 KB of %j in linear time', (unit) => {
		const time = (length: number): number => {
			const line = fill(unit, length)
			const start = performance.now()
			lexShellCommandLine(line)
			return performance.now() - start
		}
		time(size / 10)
		const small = Math.max(time(size / 10), 0.5)
		const large = time(size)
		// Ten times the input: linear is about ten times the time, quadratic
		// a hundred. The absolute bound is loose for slow CI machines; on a
		// developer machine every shape here finishes in under 200 ms.
		expect(large).toBeLessThan(1500)
		expect(large / small).toBeLessThan(40)
	})

	it('fails closed rather than overflowing the stack', () => {
		const result = lexShellCommandLine(fill('${x:-'))
		expect(result.opaque).toBe(true)
		expect(result.complete).toBe(false)
	})
})

describe('the sh dialect', () => {
	/**
	 * For a line that may run in bash or in a POSIX shell such as `dash`.
	 * Every construct the two read differently makes the line opaque, so a
	 * line that stays transparent means the same in both.
	 */
	const sh = (line: string): ShellLexResult => lexShellCommandLine(line, { dialect: 'sh' })

	it.each([
		["a $'x'", "$'…'"],
		['a $"x"', '$"…"'],
		['a |& b', '|&'],
		['a &>f', '&> and &>>'],
		['a &>>f', '&> and &>>'],
		['a <<<x', '<<<'],
		['case a in a) b;& esac', ';&'],
		['case a in a) b;;& esac', ';;&'],
		['a {b,c}', 'brace expansion'],
		['[[ a ]]', '[['],
		['((1))', '((…))'],
		['a $[1]', '$[…]'],
		['for ((;;)); do a; done', 'for ((…))'],
		['for x in a; { b; }', 'a { } loop body'],
		['select x in a; do b; done', 'select'],
		['time a', 'time'],
		['function f { a; }', 'function'],
		['coproc a', 'coproc'],
		['x=(1) a', 'array assignment'],
		['x[1]=2 a', 'subscript'],
		['x+=1 a', 'array or += assignment'],
		['a {fd}>f', '{name} redirection'],
		['a ${x/y/z}', 'parameter expansion'],
		["a ${x:-'y'}", 'parameter expansion'],
		['a 3<&-b', 'a word glued to <&- or >&-'],
		['a x\\', 'a trailing backslash'],
		['cat <<E\nx\\\nE\nE', 'a line continuation in a here-document'],
	])('%j is opaque (%s)', (line, construct) => {
		expect(sh(line).reasons).toContain(`not POSIX sh: ${construct}`)
		// The bash reading of the same line does not object to it.
		expect(lexShellCommandLine(line).reasons).not.toContain(`not POSIX sh: ${construct}`)
	})

	it.each([
		'git status -s',
		'a && b || c; d & e | f',
		'a > f 2>&1 < g >> h 3>&- <> i >| j',
		'a \'b c\' "d $e" f\\ g',
		'a ${x} ${x:-y} ${x#y} ${x%%y} ${#x} $1 $@ $?',
		'if a; then b; elif c; then d; else e; fi',
		'while a; do b; done; until c; do d; done',
		'for x in a b; do c; done',
		'case a in (b|c) d;; e) f;; esac',
		'{ a; } ; (b)',
		'! a | b',
		'cat <<E\nx\nE\nb',
		"cat <<'E'\n$(x)\nE\nb",
		'a # comment',
		'a $((1 + 2))',
	])('%j stays transparent', (line) => {
		const result = sh(line)
		expect(result.reasons).toEqual([])
		// And reads the same as bash reads it.
		expect(words(line, result)).toEqual(words(line))
	})

	it('reads a nested bash -c payload as bash, and any other shell as sh', () => {
		expect(sh(`bash -c "a |& b"`).opaque).toBe(false)
		expect(lexShellCommandLine(`sh -c "a |& b"`).reasons).toContain('not POSIX sh: |&')
		expect(lexShellCommandLine('zsh -c a').reasons).toContain('nested zsh is not modeled')
	})

	it('keeps the dialect inside a backtick substitution', () => {
		expect(sh("a `b $'c'`").reasons).toContain("not POSIX sh: $'…'")
	})
})
