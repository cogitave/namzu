import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { decideIgnore, parseIgnoreRules } from '../ignore-matcher.js'

/** Whether a path is ignored by one ignore file, as the walker asks it. */
function ignored(rules: string, path: string, isDirectory = false): boolean {
	return decideIgnore(parseIgnoreRules(rules), path, isDirectory) === 1
}

describe('ignore rule matching', () => {
	it.each([
		['ignores comments', '# dist\nsrc', 'dist', false],
		['an escaped hash is a literal name', '\\#notes', '#notes', false],
		['an unescaped trailing space is dropped', 'name   ', 'name', false],
		['an escaped trailing space is kept', 'name\\ ', 'name ', false],
		['a bare name matches at any depth', 'dist', 'a/b/dist', false],
		['a trailing slash matches directories only (file)', 'build/', 'build', false],
		['a trailing slash matches directories only (directory)', 'build/', 'a/build', true],
		['a leading slash anchors', '/dist', 'dist', false],
		['a leading slash does not match deeper', '/dist', 'a/dist', false],
		['an inner slash anchors', 'a/b', 'a/b', false],
		['an inner slash does not match deeper', 'a/b', 'x/a/b', false],
		['star does not cross a slash', 'a/*.js', 'a/b/c.js', false],
		['star matches within a name', '*.log', 'x/y/debug.log', false],
		['question mark is one character', 'f?.ts', 'fa.ts', false],
		['question mark is not a slash', 'a?b', 'a/b', false],
		['a leading double star matches any depth', '**/foo', 'x/y/foo', false],
		['a trailing double star matches everything inside', 'abc/**', 'abc/x/y', false],
		['a trailing double star does not match the directory itself', 'abc/**', 'abc', true],
		['a middle double star matches zero directories', 'a/**/b', 'a/b', false],
		['a middle double star matches many directories', 'a/**/b', 'a/x/y/b', false],
		['a character class', 'f[ab].ts', 'fb.ts', false],
		['a negated character class', 'f[!ab].ts', 'fc.ts', false],
		['a negated character class excludes members', 'f[!ab].ts', 'fa.ts', false],
		['a range', 'f[0-9]', 'f7', false],
		['a CRLF file', 'dist\r\nout\r\n', 'out', false],
		['a BOM before the first rule', '﻿dist', 'dist', false],
		['regex metacharacters are literal', 'a+b(1).txt', 'a+b(1).txt', false],
	])('%s', (_name, rules, path, isDirectory) => {
		expect(ignored(rules, path, isDirectory)).toBe(EXPECTED[_name as keyof typeof EXPECTED])
	})

	it('lets a later line re-include what an earlier one ignored', () => {
		expect(ignored('*.log\n!keep.log', 'keep.log')).toBe(false)
		expect(ignored('*.log\n!keep.log', 'other.log')).toBe(true)
		expect(ignored('!keep.log\n*.log', 'keep.log')).toBe(true)
	})

	it('drops a line it cannot read rather than hiding a visible file', () => {
		expect(ignored('a\\', 'a')).toBe(false)
		expect(ignored('[]', 'a')).toBe(false)
		// Git leaves a file named like an unclosed bracket visible.
		expect(parseIgnoreRules('a[b')).toHaveLength(0)
		expect(ignored('a[b', 'a[b')).toBe(false)
	})

	it('drops a rule with more than three separate stars, whose match could backtrack for seconds', () => {
		const hostile = '*a*a*a*a*a*a*a*a*a*a*b'
		expect(parseIgnoreRules(hostile)).toHaveLength(0)
		// The cap is on the rule, so the work per name is bounded by three nested scans.
		expect(parseIgnoreRules('*a*a*b')).toHaveLength(1)
		expect(parseIgnoreRules('**/*a*a*b')).toHaveLength(1)
		expect(ignored('*a*a*b', `${'a'.repeat(200)}c`)).toBe(false)
		expect(ignored('*.min.*.js', 'x.min.y.js')).toBe(true)
	})

	it('bounds the work of a hostile file by rule count and pattern size', () => {
		const rules = parseIgnoreRules(`${'x\n'.repeat(20_000)}`)
		expect(rules.length).toBeLessThanOrEqual(10_000)
		expect(parseIgnoreRules(`${'a'.repeat(5_000)}\n`)).toHaveLength(0)
		// More than four double stars is dropped, so no pattern chains unbounded wildcards.
		expect(parseIgnoreRules('a/**/b/**/c/**/d/**/e/**/f')).toHaveLength(0)
		// Repeated globstars collapse to one.
		expect(ignored('a/**/**/**/b', 'a/x/y/b')).toBe(true)
	})
})

// The expected answer for every row of the table above.
const EXPECTED = {
	'ignores comments': false,
	'an escaped hash is a literal name': true,
	'an unescaped trailing space is dropped': true,
	'an escaped trailing space is kept': true,
	'a bare name matches at any depth': true,
	'a trailing slash matches directories only (file)': false,
	'a trailing slash matches directories only (directory)': true,
	'a leading slash anchors': true,
	'a leading slash does not match deeper': false,
	'an inner slash anchors': true,
	'an inner slash does not match deeper': false,
	'star does not cross a slash': false,
	'star matches within a name': true,
	'question mark is one character': true,
	'question mark is not a slash': false,
	'a leading double star matches any depth': true,
	'a trailing double star matches everything inside': true,
	'a trailing double star does not match the directory itself': false,
	'a middle double star matches zero directories': true,
	'a middle double star matches many directories': true,
	'a character class': true,
	'a negated character class': true,
	'a negated character class excludes members': false,
	'a range': true,
	'a CRLF file': true,
	'a BOM before the first rule': true,
	'regex metacharacters are literal': true,
} as const

// ---------------------------------------------------------------------------
// Differential test: git is the oracle. If this matcher and git disagree, git
// is right.
// ---------------------------------------------------------------------------

function gitAvailable(): boolean {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

const RULE_LINES = [
	'node_modules/',
	'dist/',
	'/build',
	'*.log',
	'!keep.log',
	'tmp*',
	'/src/gen/',
	'**/cache',
	'docs/**/*.tmp',
	'a/*/b',
	'f?.ts',
	'[abc].txt',
	'[!x]y.md',
	'.env*',
	'!.env.example',
	'out/**',
	'!out/keep/**',
	'*.min.js',
	'lib/',
	'!lib/vendor/',
	'x/**/y',
	'\\#hash',
	'space\\ name',
	'/*.cfg',
]
const PATHS = [
	'node_modules',
	'node_modules/a/index.js',
	'dist',
	'dist/a.js',
	'src/dist',
	'build',
	'src/build',
	'a.log',
	'x/keep.log',
	'debug.log',
	'tmpfile',
	'src/tmp',
	'tmp/a',
	'src/gen',
	'src/gen/a.ts',
	'src/gen2/a.ts',
	'cache',
	'a/cache',
	'a/b/cache',
	'docs/a.tmp',
	'docs/x/y.tmp',
	'docs/x/y.md',
	'a/q/b',
	'a/q/r/b',
	'fa.ts',
	'src/fb.ts',
	'f/a.ts',
	'a.txt',
	'd.txt',
	'zy.md',
	'xy.md',
	'.env',
	'.env.local',
	'.env.example',
	'out',
	'out/a',
	'out/keep',
	'out/keep/a',
	'app.min.js',
	'a/app.min.js',
	'lib',
	'lib/a.js',
	'lib/vendor',
	'lib/vendor/a.js',
	'x/y',
	'x/a/y',
	'x/a/b/y',
	'#hash',
	'space name',
	'root.cfg',
	'sub/root.cfg',
]

describe.skipIf(!gitAvailable())('ignore rules against git', () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-ignore-diff-'))
	afterAll(() => removeTempDir(root))

	it('agrees with `git check-ignore` on a generated corpus of rules and paths', () => {
		const env = {
			...process.env,
			HOME: root,
			XDG_CONFIG_HOME: join(root, 'xdg'),
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_SYSTEM: '/dev/null',
		}
		execFileSync('git', ['init', '-q', root], { env })
		const disagreements: string[] = []
		// Each round uses a different slice of the rule list, so rule interplay is exercised.
		for (let round = 0; round < 8; round += 1) {
			const lines = RULE_LINES.filter((_, index) => (index + round) % 3 !== 0 || round === 0)
			writeFileSync(join(root, '.gitignore'), `${lines.join('\n')}\n`)
			const rules = parseIgnoreRules(`${lines.join('\n')}\n`)
			for (const path of PATHS) {
				// git decides a path through its parents: an ignored directory hides what is inside.
				const isDirectory = PATHS.some((other) => other.startsWith(`${path}/`))
				const full = join(root, path)
				mkdirSync(dirname(full), { recursive: true })
				// git reads the kind of a path from the disk, so make it real.
				if (isDirectory) mkdirSync(full, { recursive: true })
				else writeFileSync(full, '')
				const walked = walkDecision(rules, path, isDirectory)
				let viaGit: boolean
				try {
					execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], {
						cwd: root,
						env,
						stdio: 'ignore',
					})
					viaGit = true
				} catch {
					viaGit = false
				}
				if (walked !== viaGit) {
					disagreements.push(`round ${round}: ${path} mine=${walked} git=${viaGit}`)
				}
			}
		}
		expect(disagreements).toEqual([])
	})
})

/** The walker's own decision for one path: every parent directory is tested first, as the walk prunes. */
function walkDecision(
	rules: ReturnType<typeof parseIgnoreRules>,
	path: string,
	isDirectory: boolean,
): boolean {
	const parts = path.split('/')
	for (let depth = 1; depth <= parts.length; depth += 1) {
		const prefix = parts.slice(0, depth).join('/')
		const last = depth === parts.length
		if (decideIgnore(rules, prefix, last ? isDirectory : true) === 1) return true
	}
	return false
}
