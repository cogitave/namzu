import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	INLINE_SHELL_MAX_COMMANDS,
	INLINE_SHELL_MAX_COMMAND_CHARS,
	INLINE_SHELL_MAX_OUTPUT_CHARS,
	InlineShellError,
	type InlineShellHookVerdict,
	type InlineShellHost,
	type InlineShellOutcome,
	SHELL_OFF_PLACEHOLDER,
	SHELL_REMOTE_PLACEHOLDER,
	SHELL_UNTRUSTED_PLACEHOLDER,
	escapeInlineShell,
	expandInlineShell,
	findInlineShell,
	shapeShellOutput,
	splitShellToolOutput,
	substituteEscaped,
} from './inline-shell.js'

const commands = (text: string): string[] => findInlineShell(text).map((m) => m.command)

describe('findInlineShell', () => {
	const table: [string, string, string[]][] = [
		['an inline command', 'before !`git status` after', ['git status']],
		['an inline command at the start of the text', '!`pwd`', ['pwd']],
		['an inline command at the start of a line', 'a\n!`pwd`\nb', ['pwd']],
		['an inline command after a tab', 'a\t!`pwd`', ['pwd']],
		['a bang glued to a word is not a command', 'wow!`pwd`', []],
		['an escaped bang is not a command', '\\!`pwd`', []],
		['an ordinary code span is never run', 'run `git status` first', []],
		['a span next to a command does not eat it', '`a` !`b` `c`', ['b']],
		['a command after prose with a span', 'use `x`, then !`y`', ['y']],
		['a double backtick span is ordinary', 'see !``pwd``', []],
		['the body may span lines', 'x !`echo a\necho b` y', ['echo a\necho b']],
		['an empty body is nothing', 'x !`` y', []],
		['an unclosed inline is plain text', 'x !`pwd', []],
		['the command is trimmed', '!`  ls -la  `', ['ls -la']],
		['two commands in order', '!`a` and !`b`', ['a', 'b']],
		['a fenced block is one command', 'x\n```!\necho a\necho b\n```\ny', ['echo a\necho b']],
		['a fence opener may have trailing spaces', '```!  \nls\n```', ['ls']],
		['a fence opener may be indented', '  ```!\nls\n  ```', ['ls']],
		['a fence with no closing line is plain text', '```!\nls\n', []],
		['an empty fence is nothing', '```!\n\n```', []],
		['an ordinary fence is masked', '```sh\n!`rm -rf x`\n```', []],
		['a tilde fence is masked', '~~~\n!`rm -rf x`\n~~~', []],
		['a shell fence inside an ordinary fence is masked', '````md\n```!\nrm x\n```\n````', []],
		['text after a masked fence still runs', '```\nx\n```\n!`ok`', ['ok']],
		['an unclosed ordinary fence masks to the end', '```\n!`x`', []],
		['a command before a fence and after it', '!`a`\n```!\nb\n```\n!`c`', ['a', 'b', 'c']],
		['CRLF is read as LF', 'a\r\n```!\r\nls\r\n```\r\n', ['ls']],
		['a lone CR is a line end', '```!\rls\r```', ['ls']],
	]
	it.each(table)('%s', (_name, text, expected) => {
		expect(commands(text)).toEqual(expected)
	})

	it('gives the offsets of the marker in the normalised text', () => {
		const [marker] = findInlineShell('ab !`ls` cd')
		expect(marker).toMatchObject({ kind: 'inline', start: 3, end: 8, raw: '!`ls`' })
	})

	it('reports a fence as one marker covering its lines', () => {
		const [marker] = findInlineShell('p\n```!\nls\n```\nq')
		expect(marker?.kind).toBe('fence')
		expect(marker?.raw).toBe('```!\nls\n```')
	})
})

describe('escapeInlineShell', () => {
	it.each([
		['plain text is left alone', 'hello world', 'hello world'],
		['a command opener is broken', 'x !`id` y', 'x ! `id` y'],
		['a fence opener is broken', '```!\nid\n```', '``` !\nid\n```'],
		['a leading bang is escaped', '!ok', '\\!ok'],
		['a backtick span of the value is kept', 'use `ls`', 'use `ls`'],
	])('%s', (_name, input, expected) => {
		expect(escapeInlineShell(input)).toBe(expected)
	})

	it('leaves nothing a reader would run', () => {
		for (const value of ['!`id`', '```!\nid\n```', ' !`id` ', '!', '`', '!`', '`!`id`']) {
			expect(findInlineShell(escapeInlineShell(value))).toEqual([])
		}
	})
})

describe('substituteEscaped', () => {
	it('substitutes every token, escaping each value', () => {
		expect(substituteEscaped('a $ARGUMENTS b $ARGUMENTS', { $ARGUMENTS: 'x' })).toBe('a x b x')
	})

	it('runs the template author’s own commands with the value inside', () => {
		const text = substituteEscaped('!`git log $ARGUMENTS`', { $ARGUMENTS: '-n 3' })
		expect(commands(text)).toEqual(["git log '-n' '3'"])
	})

	it('keeps a value from starting a command', () => {
		const text = substituteEscaped('Review: $ARGUMENTS', { $ARGUMENTS: '!`rm -rf ~`' })
		expect(commands(text)).toEqual([])
		expect(text).toBe('Review: \\! `rm -rf ~`')
	})

	it('keeps a value from starting a fence', () => {
		const text = substituteEscaped('$ARGUMENTS', { $ARGUMENTS: '```!\nrm -rf ~\n```' })
		expect(commands(text)).toEqual([])
	})

	it('keeps a value that ends in a bang from joining the template’s backtick', () => {
		const text = substituteEscaped('x $ARGUMENTS`rm -rf ~`', { $ARGUMENTS: 'a !' })
		expect(commands(text)).toEqual([])
	})

	it('keeps a value that starts with a backtick from joining the template’s bang', () => {
		const text = substituteEscaped('x !$ARGUMENTS', { $ARGUMENTS: '`rm -rf ~`' })
		expect(commands(text)).toEqual([])
	})

	it('longest token wins', () => {
		expect(
			substituteEscaped('$ARGUMENTS_X $ARGUMENTS', { $ARGUMENTS: 'a', $ARGUMENTS_X: 'b' }),
		).toBe('b a')
	})

	it('normalises line endings', () => {
		expect(substituteEscaped('a\r\nb', { $ARGUMENTS: 'x' })).toBe('a\nb')
	})

	it('refuses a load whose value still added a command', () => {
		// A backtick in the value shifts which backticks pair, and the template's own
		// text after the slot becomes a command the author never wrote.
		const attempts = ['`', '``', 'a ` b', '` !']
		for (const value of attempts) {
			const template = 'x $ARGUMENTS !`ok` y'
			try {
				const text = substituteEscaped(template, { $ARGUMENTS: value })
				// Whatever it returns must hold no more commands than the template.
				expect(commands(text).length).toBeLessThanOrEqual(1)
			} catch (error) {
				expect(error).toBeInstanceOf(InlineShellError)
			}
		}
	})
})

describe.skipIf(process.platform === 'win32')('substituteEscaped inside a command', () => {
	const sh = { dialect: 'sh' } as const
	/** What the shell prints for each argument of `printf '<%s>'` after the value goes in. */
	function run(template: string, value: string): { out: string; files: string[] } {
		const dir = mkdtempSync(join(tmpdir(), 'inline-quote-'))
		try {
			const [command] = commands(substituteEscaped(template, { $ARGUMENTS: value }, sh))
			const out = execFileSync('sh', ['-c', command as string], { cwd: dir, encoding: 'utf8' })
			return { out, files: readdirSync(dir) }
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	}

	it('keeps word splitting: two typed words stay two arguments', () => {
		expect(run("!`printf '<%s>' $ARGUMENTS`", '-n 5').out).toBe('<-n><5>')
	})

	it('keeps a typed quote as one argument', () => {
		expect(run("!`printf '<%s>' $ARGUMENTS`", '"a b" c').out).toBe('<a b><c>')
	})

	it.each([
		['a semicolon', 'x; touch RAN #'],
		['a pipe', 'x | touch RAN'],
		['an ampersand', 'x & touch RAN'],
		['a substitution', '$(touch RAN)'],
		['a redirection', '> RAN'],
		['a newline', 'x\ntouch RAN'],
		['a quote', "'; touch RAN; '"],
		['a double quote', '"; touch RAN; "'],
	])('does not run %s', (_name, value) => {
		const { files } = run("!`printf '<%s>' $ARGUMENTS`", value)
		expect(files).toEqual([])
	})

	it('keeps a value literal inside double quotes', () => {
		const { out, files } = run('!`printf \'<%s>\' "$ARGUMENTS"`', '$(touch RAN) "q" $HOME \\')
		expect(out).toBe('<$(touch RAN) "q" $HOME \\>')
		expect(files).toEqual([])
	})

	it('keeps a value literal inside single quotes', () => {
		const { out, files } = run("!`printf '<%s>' '$ARGUMENTS'`", "it's; touch RAN")
		expect(out).toBe("<it's; touch RAN>")
		expect(files).toEqual([])
	})

	it('quotes by the quotes opened inside a substitution', () => {
		const { files } = run('!`printf \'<%s>\' "$(echo $ARGUMENTS)"`', 'x; touch RAN')
		expect(files).toEqual([])
	})

	it('works inside a fenced command too', () => {
		const text = substituteEscaped(
			'```!\necho start\nprintf "<%s>" $ARGUMENTS\n```',
			{
				$ARGUMENTS: 'a; touch RAN',
			},
			sh,
		)
		expect(commands(text)).toEqual(["echo start\nprintf \"<%s>\" 'a;' 'touch' 'RAN'"])
	})

	it('leaves text outside commands as it was', () => {
		expect(substituteEscaped('Review $ARGUMENTS; done', { $ARGUMENTS: 'a b; c' }, sh)).toBe(
			'Review a b; c; done',
		)
	})

	it.each([['a backtick', 'a`b']])('refuses %s inside a command', (_name, value) => {
		expect(() => substituteEscaped('!`echo $ARGUMENTS`', { $ARGUMENTS: value }, sh)).toThrow(
			InlineShellError,
		)
	})

	it.each([
		['a here-document', '!`cat <<EOF\n$ARGUMENTS\nEOF`'],
		['a parameter expansion', '!`echo ${x:-$ARGUMENTS}`'],
		['an arithmetic expansion', '!`echo $(( $ARGUMENTS ))`'],
	])('refuses a value inside %s', (_name, template) => {
		expect(() => substituteEscaped(template, { $ARGUMENTS: 'a' }, sh)).toThrow(InlineShellError)
	})

	it('quotes the skill folder like an argument inside a command', () => {
		const text = substituteEscaped(
			'!`ls ${NAMZU_SKILL_DIR}/x`',
			{ '${NAMZU_SKILL_DIR}': '/a b/c;d' },
			sh,
		)
		expect(commands(text)).toEqual(["ls '/a' 'b/c;d'/x"])
	})

	it('refuses words the Windows command interpreter would read as syntax', () => {
		expect(() =>
			substituteEscaped('!`echo $ARGUMENTS`', { $ARGUMENTS: 'a & b' }, { dialect: 'cmd' }),
		).toThrow(InlineShellError)
		expect(
			commands(substituteEscaped('!`echo $ARGUMENTS`', { $ARGUMENTS: 'a b' }, { dialect: 'cmd' })),
		).toEqual(['echo a b'])
	})
})

describe('shapeShellOutput', () => {
	it.each([
		['trimmed stdout', '  hi \n', '', 'hi'],
		['no output', '', '', ''],
		['stderr after stdout', 'out\n', 'oops\n', 'out\n[stderr]\noops'],
		['stderr alone', '', 'oops', '[stderr]\noops'],
		['blank stderr is dropped', 'out', '  \n', 'out'],
	])('%s', (_name, out, err, expected) => {
		expect(shapeShellOutput(out, err)).toBe(expected)
	})
})

describe('splitShellToolOutput', () => {
	it.each([
		['both streams', 'STDOUT:\na\n\nSTDERR:\nb', { stdout: 'a', stderr: 'b' }],
		['stdout only', 'STDOUT:\na', { stdout: 'a', stderr: '' }],
		['stderr only', 'STDERR:\nb', { stdout: '', stderr: 'b' }],
		['no output', '(no output)', { stdout: '', stderr: '' }],
		['unlabelled', 'plain', { stdout: 'plain', stderr: '' }],
	])('%s', (_name, output, expected) => {
		expect(splitShellToolOutput(output)).toEqual(expected)
	})
})

/** A host whose commands answer from a table and which records what it was asked. */
function fakeHost(
	answers: (command: string) => InlineShellOutcome | 'run',
	run?: (command: string) => { stdout: string; stderr: string; exitCode: number },
): InlineShellHost & { readonly asked: string[]; readonly started: string[] } {
	const asked: string[] = []
	const started: string[] = []
	return {
		asked,
		started,
		async run(command, beforeRun) {
			asked.push(command)
			const answer = answers(command)
			if (answer !== 'run') return answer
			const verdict = await beforeRun()
			if (verdict.kind !== 'run') return { kind: 'hook', verdict }
			started.push(command)
			const done = run?.(command) ?? { stdout: `ran ${command}`, stderr: '', exitCode: 0 }
			return { kind: 'ran', ...done }
		},
	}
}

describe('expandInlineShell', () => {
	it('replaces only the marker with the trimmed output', async () => {
		const host = fakeHost(
			() => 'run',
			() => ({ stdout: '  main\n', stderr: '', exitCode: 0 }),
		)
		const text = await expandInlineShell('Branch: !`git branch` (now)', { host, commandName: 's' })
		expect(text).toBe('Branch: main (now)')
	})

	it('puts a [stderr] block after the output', async () => {
		const host = fakeHost(
			() => 'run',
			() => ({ stdout: 'a', stderr: 'warn', exitCode: 0 }),
		)
		expect(await expandInlineShell('!`x`', { host, commandName: 's' })).toBe('a\n[stderr]\nwarn')
	})

	it('runs a fenced block as one command', async () => {
		const host = fakeHost(() => 'run')
		await expandInlineShell('```!\na\nb\n```', { host, commandName: 's' })
		expect(host.started).toEqual(['a\nb'])
	})

	it('returns text with no command unchanged apart from line endings', async () => {
		const host = fakeHost(() => 'run')
		expect(await expandInlineShell('a\r\nb `c`', { host, commandName: 's' })).toBe('a\nb `c`')
		expect(host.asked).toEqual([])
	})

	it('runs commands in order', async () => {
		const host = fakeHost(() => 'run')
		await expandInlineShell('!`a` !`b` !`c`', { host, commandName: 's' })
		expect(host.started).toEqual(['a', 'b', 'c'])
	})

	describe('permission', () => {
		it('fails the whole load on a refusal, with the reason', async () => {
			const host = fakeHost((c) =>
				c === 'bad' ? { kind: 'denied', reason: 'no rule allows it' } : 'run',
			)
			await expect(
				expandInlineShell('!`ok` !`bad`', { host, commandName: 's' }),
			).rejects.toMatchObject({
				reason: 'permission',
				message: 'Shell command permission check failed for pattern "bad": no rule allows it',
			})
		})

		it('does not ask the hook for a command that was refused', async () => {
			let asked = 0
			const host = fakeHost(() => ({ kind: 'denied', reason: 'no' }))
			await expect(
				expandInlineShell('!`x`', {
					host,
					commandName: 's',
					hook: async () => {
						asked += 1
						return { kind: 'run' }
					},
				}),
			).rejects.toBeInstanceOf(InlineShellError)
			expect(asked).toBe(0)
		})
	})

	describe('failure', () => {
		it('fails on a non-zero exit with the output', async () => {
			const host = fakeHost(
				() => 'run',
				() => ({ stdout: 'half', stderr: 'boom', exitCode: 3 }),
			)
			await expect(expandInlineShell('!`x`', { host, commandName: 's' })).rejects.toMatchObject({
				reason: 'failed',
				message: 'Shell command failed for pattern "x": half\n[stderr]\nboom',
			})
		})

		it('names the exit code when there is no output', async () => {
			const host = fakeHost(
				() => 'run',
				() => ({ stdout: '', stderr: '', exitCode: 1 }),
			)
			await expect(expandInlineShell('!`x`', { host, commandName: 's' })).rejects.toThrow(
				'exit code 1',
			)
		})

		it('fails on an interrupt', async () => {
			const host: InlineShellHost = {
				run: async () => ({
					kind: 'ran',
					stdout: '',
					stderr: '',
					exitCode: null,
					interrupted: true,
				}),
			}
			await expect(expandInlineShell('!`x`', { host, commandName: 's' })).rejects.toMatchObject({
				reason: 'interrupted',
				message: 'Shell command interrupted for pattern "x": [Command interrupted]',
			})
		})

		it('shortens a long command in the message', async () => {
			const long = 'x'.repeat(200)
			const host = fakeHost(
				() => 'run',
				() => ({ stdout: '', stderr: 'e', exitCode: 1 }),
			)
			const error = await expandInlineShell(`!\`${long}\``, { host, commandName: 's' }).catch(
				(e: Error) => e,
			)
			expect((error as Error).message).toContain(`"${'x'.repeat(79)}…"`)
		})
	})

	describe('limits', () => {
		it('allows exactly 256 commands and refuses 257', async () => {
			const host = fakeHost(() => 'run')
			const make = (n: number) => Array.from({ length: n }, (_, i) => `!\`c${i}\``).join(' ')
			await expect(
				expandInlineShell(make(INLINE_SHELL_MAX_COMMANDS), { host, commandName: 's' }),
			).resolves.toBeTypeOf('string')
			const refused = fakeHost(() => 'run')
			await expect(
				expandInlineShell(make(INLINE_SHELL_MAX_COMMANDS + 1), { host: refused, commandName: 's' }),
			).rejects.toMatchObject({ reason: 'limit' })
			expect(refused.asked).toEqual([])
		})

		it('allows a 32 KB command and refuses one character more', async () => {
			const host = fakeHost(
				() => 'run',
				() => ({ stdout: '', stderr: '', exitCode: 0 }),
			)
			await expect(
				expandInlineShell(`!\`${'a'.repeat(INLINE_SHELL_MAX_COMMAND_CHARS)}\``, {
					host,
					commandName: 's',
				}),
			).resolves.toBe('')
			const refused = fakeHost(() => 'run')
			await expect(
				expandInlineShell(`!\`${'a'.repeat(INLINE_SHELL_MAX_COMMAND_CHARS + 1)}\``, {
					host: refused,
					commandName: 's',
				}),
			).rejects.toMatchObject({ reason: 'limit' })
			expect(refused.asked).toEqual([])
		})

		it('allows 4 MB of output in all and refuses one character more', async () => {
			const half = INLINE_SHELL_MAX_OUTPUT_CHARS / 2
			const exact = fakeHost(
				() => 'run',
				() => ({ stdout: 'x'.repeat(half), stderr: '', exitCode: 0 }),
			)
			const okText = await expandInlineShell('!`a` !`b`', { host: exact, commandName: 's' })
			expect(okText.length).toBe(INLINE_SHELL_MAX_OUTPUT_CHARS + 1)
			let n = 0
			const over = fakeHost(
				() => 'run',
				() => ({ stdout: 'x'.repeat(n++ === 0 ? half : half + 1), stderr: '', exitCode: 0 }),
			)
			await expect(
				expandInlineShell('!`a` !`b`', { host: over, commandName: 's' }),
			).rejects.toMatchObject({ reason: 'limit' })
		})
	})

	describe('the switch and the sources', () => {
		it.each([
			['off', SHELL_OFF_PLACEHOLDER],
			['remote', SHELL_REMOTE_PLACEHOLDER],
			['untrusted', SHELL_UNTRUSTED_PLACEHOLDER],
		] as const)('%s leaves a placeholder and runs nothing', async (block, placeholder) => {
			const host = fakeHost(() => 'run')
			const text = await expandInlineShell('a !`x`\n```!\ny\n```', {
				host,
				commandName: 's',
				block,
			})
			expect(text).toBe(`a ${placeholder}\n${placeholder}`)
			expect(host.asked).toEqual([])
		})

		it('does not apply the command limit to placeholders', async () => {
			const host = fakeHost(() => 'run')
			const many = Array.from({ length: 300 }, () => '!`x`').join(' ')
			await expect(
				expandInlineShell(many, { host, commandName: 's', block: 'off' }),
			).resolves.toContain(SHELL_OFF_PLACEHOLDER)
		})
	})

	describe('the hook', () => {
		const withHook = (verdict: InlineShellHookVerdict) => ({
			hook: async () => verdict,
		})

		it('runs the command when the hook says run, and shows its warning', async () => {
			const warnings: string[] = []
			const host = fakeHost(() => 'run')
			await expandInlineShell('!`x`', {
				host,
				commandName: 's',
				...withHook({ kind: 'run', warning: 'careful' }),
				warn: (line) => warnings.push(line),
			})
			expect(host.started).toEqual(['x'])
		})

		it('leaves a placeholder and a warning for a refused command and loads the rest', async () => {
			const warnings: string[] = []
			const host = fakeHost(() => 'run')
			const text = await expandInlineShell('a !`x` b !`y`', {
				host,
				commandName: 'review',
				hook: async (command) =>
					command === 'x' ? { kind: 'refuse', reason: 'not on a Friday' } : { kind: 'run' },
				warn: (line) => warnings.push(line),
			})
			expect(text).toBe('a [not run: blocked by hook: not on a Friday] b ran y')
			expect(host.started).toEqual(['y'])
			expect(warnings).toEqual(['Not run in /review: x (blocked by hook: not on a Friday)'])
		})

		it('names a refused fenced block by its first line and how many lines follow', async () => {
			const warnings: string[] = []
			const host = fakeHost(() => 'run')
			await expandInlineShell('```!\necho one\necho two\necho three\n```', {
				host,
				commandName: 'review',
				hook: async () => ({ kind: 'refuse', reason: 'read only here' }),
				warn: (line) => warnings.push(line),
			})
			expect(warnings).toEqual([
				'Not run in /review: echo one (+2 more lines) (blocked by hook: read only here)',
			])
		})

		it('leaves a bare placeholder when the hook gave no reason', async () => {
			const host = fakeHost(() => 'run')
			const text = await expandInlineShell('!`x`', {
				host,
				commandName: 's',
				...withHook({ kind: 'refuse' }),
			})
			expect(text).toBe('[not run: blocked by hook]')
		})

		it('cuts a long reason to 500 characters and a long command to 80', async () => {
			const warnings: string[] = []
			const host = fakeHost(() => 'run')
			const text = await expandInlineShell(`!\`${'c'.repeat(300)}\``, {
				host,
				commandName: 's',
				...withHook({ kind: 'refuse', reason: 'r'.repeat(900) }),
				warn: (line) => warnings.push(line),
			})
			expect(text).toBe(`[not run: blocked by hook: ${'r'.repeat(499)}…]`)
			expect(warnings[0]).toContain(`${'c'.repeat(79)}…`)
			expect(warnings[0]).not.toContain('c'.repeat(81))
		})

		it('stops the whole load when the hook says stop', async () => {
			const host = fakeHost(() => 'run')
			await expect(
				expandInlineShell('!`a` !`b`', {
					host,
					commandName: 's',
					hook: async (command) =>
						command === 'b' ? { kind: 'stop', reason: 'enough' } : { kind: 'run' },
				}),
			).rejects.toMatchObject({ reason: 'stopped', message: '/s was stopped by a hook: enough' })
		})

		it('shows the hook’s own message beside a refusal', async () => {
			const warnings: string[] = []
			const host = fakeHost(() => 'run')
			await expandInlineShell('!`a`', {
				host,
				commandName: 's',
				...withHook({ kind: 'refuse', reason: 'x', warning: 'the hook says hello' }),
				warn: (line) => warnings.push(line),
			})
			expect(warnings[0]).toBe('the hook says hello')
		})

		it('asks no hook when none is attached', async () => {
			const host = fakeHost(() => 'run')
			await expect(expandInlineShell('!`a`', { host, commandName: 's' })).resolves.toBe('ran a')
		})
	})

	it('honours an aborted signal before starting a command', async () => {
		const controller = new AbortController()
		controller.abort(new Error('stopped'))
		const host = fakeHost(() => 'run')
		await expect(
			expandInlineShell('!`a`', { host, commandName: 's', signal: controller.signal }),
		).rejects.toThrow('stopped')
		expect(host.asked).toEqual([])
	})
})
