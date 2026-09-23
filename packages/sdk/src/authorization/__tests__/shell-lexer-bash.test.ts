import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ShellCommand, type ShellLexResult, lexShellCommandLine } from '../shell-lexer.js'

/**
 * The lexer against the bash on this machine.
 *
 * For each line, bash is asked which commands it would run, without running
 * any of them: PATH names an empty directory, every builtin that could act or
 * stand in for a command is disabled, and `command_not_found_handle` records
 * the argv it receives. The line runs through `eval` in a subshell, once with
 * the handler reporting success and once failure, so both sides of `&&` and
 * `||` are seen. Then:
 *
 * - bash reports a syntax error ⇒ the lexer must call the line opaque;
 * - the lexer does not call the line opaque ⇒ every command bash ran must be
 *   one the lexer listed, word for word, with a word the lexer flags as
 *   expanding standing for any run of bash's words, and in order when
 *   nothing in the line runs concurrently or loops.
 *
 * The corpus is every sequence of up to three tokens over the characters
 * that matter to quoting and control, wrapped in commands, plus a seeded
 * random sample from a small grammar and the cases earlier readers got wrong.
 * Nothing in it names a path, so nothing it contains can reach an executable.
 * The scratchpad harness this came from also ran every sequence of five
 * tokens (2.9 million lines) and 250 000 random lines against bash 5.2 and
 * 5.3, with no mismatch.
 */

const run = promisify(execFile)

/** The bash on PATH: its absolute path and major version. */
function findBash(): { readonly path: string; readonly major: number } | undefined {
	if (process.platform === 'win32') return undefined
	const probe = spawnSync(
		'bash',
		['--norc', '--noprofile', '-c', 'echo "${BASH_VERSINFO[0]} $BASH"'],
		{
			encoding: 'utf8',
		},
	)
	if (probe.status !== 0) return undefined
	const [major, path] = probe.stdout.trim().split(' ')
	return major === undefined || path === undefined ? undefined : { path, major: Number(major) }
}

const bash = findBash()
const available = bash !== undefined && bash.major >= 5

/**
 * The builtins that would run in place of the handler, or change what later
 * text means. `eval` and `enable` stay, because the driver needs them, and
 * the assignment builtins stay, because bash parses `declare x=(…)` only
 * when `declare` is a builtin; lines that call any of these are skipped.
 */
const DISABLED =
	'. : [ alias bg bind break builtin caller cd command compgen complete compopt continue dirs disown echo exec exit false fc fg getopts hash help history jobs kill let logout mapfile popd printf pushd pwd read readarray return set shift shopt source suspend test times trap true type ulimit umask unalias unset'
const SKIPPED_HEADS = new Set([
	'enable',
	'eval',
	'wait',
	'declare',
	'typeset',
	'local',
	'export',
	'readonly',
])

// The handler writes one record per command with a single printf: bash
// line-buffers stdout, so backslash and newline are escaped to keep each
// record one write. `R<line>:<argc>:` then `<length>:<bytes>` per argument.
const DRIVER = `
__H=$1
__OUT=$2
command_not_found_handle() {
  enable printf
  local __r="R$__I:$#:" __a
  for __a; do __a=\${__a//\\\\/\\\\\\\\}; __a=\${__a//$'\\n'/\\\\n}; __r+="\${#__a}:$__a"; done
  printf '%s' "$__r" >&57
  ((__H))
}
__run() {
  __I=$2
  (
    : > a; : > b
    enable -n ${DISABLED}
    eval -- "$1"
    wait
  ) </dev/null >/dev/null 2>"$__OUT/e$2"
  printf 'E' >&57
}
source "$__OUT/lines.sh"
`

interface Observed {
	readonly runs: string[][]
	readonly syntaxError: boolean
}

let root = ''

async function observe(lines: readonly string[], succeed: boolean): Promise<Observed[]> {
	const out = mkdtempSync(join(root, 'run-'))
	const work = join(out, 'work')
	mkdirSync(work)
	const quote = (line: string): string =>
		`$'${[...Buffer.from(line, 'latin1')].map((byte) => (/[A-Za-z0-9 ]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `\\x${byte.toString(16).padStart(2, '0')}`)).join('')}'`
	writeFileSync(
		join(out, 'lines.sh'),
		lines.map((line, index) => `__run ${quote(line)} ${index}\n`).join(''),
		'latin1',
	)
	writeFileSync(join(out, 'driver.sh'), DRIVER)
	await run(
		bash?.path ?? 'bash',
		[
			'--norc',
			'--noprofile',
			'-c',
			'source "$3/driver.sh" "$1" "$3" 57>>"$3/57"',
			'zz0',
			succeed ? '1' : '0',
			'',
			out,
		],
		{
			cwd: work,
			env: { PATH: join(root, 'empty'), HOME: join(root, 'home'), LC_ALL: 'C' },
			maxBuffer: 1 << 26,
		},
	)
	const raw = readFileSync(join(out, '57')).toString('latin1')
	const byLine: string[][][] = lines.map(() => [])
	let i = 0
	const number = (): number => {
		const colon = raw.indexOf(':', i)
		const value = Number(raw.slice(i, colon))
		i = colon + 1
		return value
	}
	let markers = 0
	while (i < raw.length) {
		const tag = raw[i]
		i += 1
		if (tag === 'E') {
			markers += 1
			continue
		}
		if (tag !== 'R') throw new Error(`unreadable record stream at ${i}`)
		const index = number()
		const argc = number()
		const argv: string[] = []
		for (let k = 0; k < argc; k += 1) {
			const length = number()
			argv.push(
				raw.slice(i, i + length).replace(/\\(\\|n)/g, (_, c: string) => (c === 'n' ? '\n' : '\\')),
			)
			i += length
		}
		byLine[index]?.push(argv)
	}
	expect(markers).toBe(lines.length)
	const observed = lines.map((_, index) => {
		let stderr = ''
		try {
			stderr = readFileSync(join(out, `e${index}`), 'latin1')
		} catch {}
		return {
			runs: byLine[index] as string[][],
			syntaxError: /(?:eval|command substitution): line \d+: (?:syntax error|unexpected)/.test(
				stderr,
			),
		}
	})
	rmSync(out, { recursive: true, force: true })
	return observed
}

/** Whether bash's argv fits the lexer's command; a flagged word stands for any run of words. */
function fits(command: ShellCommand, argv: readonly string[]): boolean {
	const words = command.words.slice(command.assignments)
	let reachable = new Array<boolean>(argv.length + 1).fill(false)
	reachable[0] = true
	for (const word of words) {
		const next = new Array<boolean>(argv.length + 1).fill(false)
		let any = false
		for (let j = 0; j <= argv.length; j += 1) {
			if (word.expands) {
				any = any || (reachable[j] as boolean)
				next[j] = any
			} else if (j > 0) next[j] = (reachable[j - 1] as boolean) && argv[j - 1] === word.value
		}
		reachable = next
	}
	return reachable[argv.length] as boolean
}

/** The disagreement for one line, or undefined. */
function disagreement(
	line: string,
	lexed: ShellLexResult,
	observed: readonly Observed[],
): string | undefined {
	if (
		lexed.commands.some((command) =>
			SKIPPED_HEADS.has(command.words[command.assignments]?.value ?? ''),
		)
	) {
		return undefined
	}
	if (observed.some((o) => o.syntaxError)) {
		return lexed.opaque
			? undefined
			: 'bash reports a syntax error and the lexer does not call the line opaque'
	}
	if (lexed.opaque) return undefined
	const listed = lexed.commands.filter(
		(command) =>
			command.origin === 'line' &&
			command.depth === 0 &&
			command.words.length > command.assignments,
	)
	const ordered = !/[|&]/.test(line) && !/\b(?:for|while|until|select)\b/.test(line)
	for (const { runs } of observed) {
		let cursor = 0
		for (const argv of runs) {
			let found = -1
			for (let k = ordered ? cursor : 0; k < listed.length && found < 0; k += 1) {
				if (fits(listed[k] as ShellCommand, argv)) found = k
			}
			if (found < 0) {
				const seen = listed.map((c) => c.words.map((w) => (w.expands ? `~${w.value}` : w.value)))
				return `bash ran ${JSON.stringify(argv)}; the lexer listed ${JSON.stringify(seen)}`
			}
			if (ordered) cursor = found + 1
		}
	}
	return undefined
}

async function check(
	lines: readonly string[],
): Promise<{ checked: number; exact: number; failures: string[] }> {
	const batch = 400
	const batches: string[][] = []
	for (let i = 0; i < lines.length; i += batch) batches.push(lines.slice(i, i + batch))
	const failures: string[] = []
	let exact = 0
	let next = 0
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next
			next += 1
			const lines = batches[index]
			if (lines === undefined) return
			const [succeeding, failing] = await Promise.all([observe(lines, true), observe(lines, false)])
			lines.forEach((line, k) => {
				const lexed = lexShellCommandLine(line)
				if (!lexed.opaque) exact += 1
				const problem = disagreement(line, lexed, [
					succeeding[k] as Observed,
					failing[k] as Observed,
				])
				if (problem !== undefined) failures.push(`${JSON.stringify(line)}: ${problem}`)
			})
		}
	}
	// Two bash processes per worker; kept few so the suite around it is not
	// starved of CPU.
	await Promise.all(
		Array.from({ length: Math.max(1, Math.min(3, Math.floor(cpus().length / 4))) }, worker),
	)
	return { checked: lines.length, exact, failures }
}

const ALPHABET = [
	'a',
	'$',
	"'",
	'"',
	'\\',
	';',
	'&',
	'|',
	' ',
	'#',
	'{',
	'}',
	'(',
	')',
	'<',
	'>',
	'\n',
	"$'",
	'$"',
]

function exhaustive(maxLength: number): string[] {
	const lines: string[] = []
	let sequences = ['']
	for (let length = 1; length <= maxLength; length += 1) {
		sequences = sequences.flatMap((prefix) => ALPHABET.map((token) => prefix + token))
		for (const sequence of sequences) lines.push(`a ${sequence} ; b`, `a${sequence}b\nb`)
	}
	return lines
}

function random(count: number, seed: number): string[] {
	let state = seed >>> 0
	const next = (): number => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
	const repeat = (max: number, part: () => string): string =>
		Array.from({ length: Math.floor(next() * max) }, part).join('')
	const part = (): string =>
		pick([
			() =>
				pick([
					'a',
					'b',
					'ab',
					'-c',
					'bash',
					'sh',
					'x=1',
					'if',
					'then',
					'fi',
					'!',
					'in',
					'esac',
					'{',
					'}',
					'time',
					'[[',
					']]',
					'2',
					'%',
				]),
			() => `'${repeat(4, () => pick(['a', ' ', ';', '\\', '"', '$(', '`', '#', '\n']))}'`,
			() =>
				`"${repeat(4, () => pick(['a', ' ', ';', '\\"', '\\\\', '\\$', "'", '$', '$a', '${a}', '$$', '\\\n', '(', '{', '$${', '$$(']))}"`,
			() =>
				`$'${repeat(4, () => pick(['a', ';', '\\x3b', '\\n', "\\'", '\\\\', '\\101', '\\cA', '\\e', '\\z', '\\u0041', '"']))}'`,
			() =>
				pick([
					'$a',
					'${a:-b}',
					"${a:-'}'}",
					'$$',
					'$?',
					'$#',
					'$1',
					'$@',
					'$((1+2))',
					'$(a)',
					'`a`',
					'<(a)',
				]),
			() => pick(['\\;', '\\ ', '\\\\', '\\$', "\\'", '\\\n', '\\#', '*', '{a,b}', '{a}']),
		])()
	const word = (): string => part() + repeat(2, part)
	const simple = (): string => {
		const items = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
			next() < 0.15
				? `${pick(['>', '>>', '<', '2>&1', '>&2', '&>', '<<<', '3<&-'])}${pick(['', ' '])}${word()}`
				: word(),
		)
		return items.join(pick([' ', '\t', ' \\\n ']))
	}
	const command = (depth: number): string => {
		const r = next()
		if (depth < 2 && r < 0.08) return `bash -c '${list(depth + 1).replace(/'/g, "'\\''")}'`
		if (depth < 2 && r < 0.14) return `{ ${list(depth + 1)}; }`
		if (depth < 2 && r < 0.2) return `( ${list(depth + 1)} )`
		if (depth < 2 && r < 0.24) return `if ${list(depth + 1)}; then ${list(depth + 1)}; fi`
		if (depth < 2 && r < 0.27) return `case ${word()} in ${word()}) ${list(depth + 1)};; esac`
		if (r < 0.31) return `${pick(['!', 'time'])} ${simple()}`
		if (r < 0.35)
			return `${simple()} <<${pick(['E', "'E'"])}\n${pick(['x', '$(a)', 'a; b', 'x\\'])}\nE`
		return simple()
	}
	const list = (depth: number): string => {
		let text = command(depth)
		while (next() < 0.35)
			text += `${pick([' ; ', ' && ', ' || ', ' | ', ' & ', '\n'])}${command(depth)}`
		return text
	}
	return Array.from({ length: count }, () => list(0))
}

/** Lines earlier readers of command lines got wrong. */
const KNOWN = [
	"git status $'\\'' ; touch pwned #'",
	"echo $'a \\' ; b' && git push",
	"echo $$'\\' ; git push origin main #'",
	"echo $$$'\\'' ; git push origin main #'",
	"git status $'\\'' > b #'",
	'bash "-c" "git push"',
	'bash -c "bash -c \\"git push\\""',
	'(cd build && make)',
	'echo a \\&\\& b',
	'echo a 2>&1 &>log >&2',
	'b 3<&-a',
	'a\\;b',
	'a &\\\n& b',
	"a ${x:-'}'} b",
	'a "${x:-"}"}" b',
	'a |& b',
	'cat <<EOF\nx\\\nEOF\nEOF\nb',
	"cat <<'EOF' ; a\n$(x)\nEOF\nb",
	'cat <<-EOF\n\tx\n\tEOF\nb',
	'a <<a\n; b',
	"a 'x\ny'\\",
	"a $'x\ny'\\",
	'a | time b',
	'x=1 if',
	'a[x y] b',
	'b a[x y]',
	'>a &>>b= c',
	'case x in esac) a;; esac',
	`a "$\${x:-"'$(b)'"}"`,
	"x >&2'$(b)'",
	'a ${ b; }d; e',
	"fi\\\nb=ab $'' c",
	'a\\\n[[+',
	'2\\\n>f a',
]

describe.skipIf(!available)('the lexer agrees with bash', () => {
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), 'namzu-shell-lexer-'))
		mkdirSync(join(root, 'empty'))
	})

	afterAll(() => {
		if (root !== '') rmSync(root, { recursive: true, force: true })
	})

	it('on the known cases', async () => {
		const result = await check(KNOWN)
		expect(result.failures).toEqual([])
	})

	it('on every sequence of up to three tokens', { timeout: 180_000 }, async () => {
		const result = await check(exhaustive(3))
		expect(result.failures).toEqual([])
		// Most short sequences do not parse; enough of them do to mean something.
		expect(result.exact).toBeGreaterThan(3000)
	})

	it('on a seeded sample of longer lines', { timeout: 180_000 }, async () => {
		const result = await check(random(2000, 526))
		expect(result.failures).toEqual([])
		expect(result.exact).toBeGreaterThan(700)
	})
})
