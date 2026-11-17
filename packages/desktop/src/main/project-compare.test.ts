import { describe, expect, it } from 'vitest'
import {
	type GitBytes,
	createProjectCompare,
	parseNameStatus,
	parseNumstat,
	parseRequest,
	projectPathSegments,
	validBase,
	validCommit,
	validRef,
} from './project-compare.js'

const buf = (text: string) => Buffer.from(text, 'utf8')

describe('what reaches git', () => {
	it('accepts ordinary branch names and refuses option look-alikes', () => {
		for (const ok of ['main', 'feature/x-1', 'origin/dev', 'v1.2.3'])
			expect(validRef(ok)).toBe(true)
		for (const bad of [
			'',
			'-D',
			'--output=x',
			'a..b',
			'a b',
			'a;b',
			'/x',
			'x/',
			'a//b',
			'x'.repeat(201),
		])
			expect(validRef(bad)).toBe(false)
		expect(validRef(undefined)).toBe(false)
	})

	it('accepts hashes of seven to forty hex characters only', () => {
		expect(validCommit('abc1234')).toBe(true)
		expect(validCommit('abc123')).toBe(false)
		expect(validCommit('g'.repeat(40))).toBe(false)
		expect(validCommit('a'.repeat(41))).toBe(false)
	})

	it('checks a whole request and keeps only what it knows', () => {
		expect(validBase({ kind: 'head' })).toBe(true)
		expect(validBase({ kind: 'branch', ref: '--x' })).toBe(false)
		expect(parseRequest({ op: 'branches', junk: 1 })).toEqual({ op: 'branches' })
		expect(parseRequest({ op: 'changes', base: { kind: 'head' }, hideWhitespace: 'yes' })).toEqual({
			op: 'changes',
			base: { kind: 'head' },
		})
		expect(parseRequest({ op: 'diff', base: { kind: 'head' }, path: '../x' })).toBeNull()
		expect(parseRequest({ op: 'diff', base: { kind: 'head' }, path: 'src/a.ts' })).toEqual({
			op: 'diff',
			base: { kind: 'head' },
			path: 'src/a.ts',
		})
		expect(parseRequest({ op: 'rm' })).toBeNull()
		expect(parseRequest('x')).toBeNull()
	})

	it('refuses paths that leave the folder or reach .git', () => {
		expect(projectPathSegments('src/a.ts')).toEqual(['src', 'a.ts'])
		for (const bad of ['../a', '/etc/passwd', '.git/config', 'a/.GIT/x', '~', 'a\u0000b', ''])
			expect(projectPathSegments(bad)).toBeNull()
	})
})

describe('git output', () => {
	it('reads numstat with renames and binary files', () => {
		const data = buf('3\t1\tsrc/a.ts\0-\t-\timg.png\0')
		expect(parseNumstat(data)).toEqual([
			{ path: 'src/a.ts', added: 3, removed: 1, binary: false },
			{ path: 'img.png', added: 0, removed: 0, binary: true },
		])
		expect(parseNumstat(buf('0\t0\t\0old.ts\0new.ts\0'))).toEqual([
			{ path: 'new.ts', oldPath: 'old.ts', added: 0, removed: 0, binary: false },
		])
	})

	it('drops a record the output cap cut in half', () => {
		expect(parseNumstat(buf('3\t1\tsrc/a.ts\0'), false)).toHaveLength(1)
		expect(parseNumstat(buf('3\t1\tsrc/a.ts\0 4\t2\tsrc/b'), true)).toHaveLength(1)
	})

	it('reads name-status keyed by the current path', () => {
		const map = parseNameStatus(buf('M\0a.ts\0R100\0old.ts\0new.ts\0'))
		expect(map.get('a.ts')).toEqual({ letter: 'M' })
		expect(map.get('new.ts')).toEqual({ letter: 'R', oldPath: 'old.ts' })
	})
})

describe('branches, commits and changes through git', () => {
	const fake = (answers: Record<string, string>): GitBytes => {
		return async (args) => {
			const key = args
				.filter(
					(a) => !a.startsWith('-c') && a !== 'core.fsmonitor=false' && a !== '--no-optional-locks',
				)
				.join(' ')
			for (const [needle, out] of Object.entries(answers))
				if (key.startsWith(needle)) return { data: buf(out), truncated: false }
			const error = new Error(`no answer for ${key}`) as Error & { code: number }
			error.code = 1
			throw error
		}
	}

	it('lists branches, leaving out HEAD pointers, and finds the usual one', async () => {
		const compare = createProjectCompare({
			run: fake({
				'rev-parse --is-inside-work-tree': 'true\n',
				'for-each-ref':
					'refs/heads/dev\nrefs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/remotes/origin/zz\n',
				'symbolic-ref --short -q HEAD': 'dev\n',
				'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main\n',
			}),
		})
		const reply = await compare('/p', { op: 'branches' })
		expect(reply).toMatchObject({
			op: 'branches',
			current: 'dev',
			defaultBranch: 'main',
			branches: [
				{ name: 'dev', remote: false },
				{ name: 'main', remote: false },
				{ name: 'origin/main', remote: true },
				{ name: 'origin/zz', remote: true },
			],
		})
	})

	it('answers null outside a repository', async () => {
		const compare = createProjectCompare({ run: fake({}) })
		expect(await compare('/p', { op: 'branches' })).toBeNull()
		expect(await compare('/p', { op: 'changes', base: { kind: 'head' } })).toBeNull()
	})

	it('lists the newest commits with the count behind them', async () => {
		const sha = 'a'.repeat(40)
		const compare = createProjectCompare({
			run: fake({
				'rev-parse --is-inside-work-tree': 'true\n',
				log: `${sha}\x1faaaaaaa\x1fFix it\n`,
				'rev-list --count': '120\n',
			}),
		})
		expect(await compare('/p', { op: 'commits' })).toEqual({
			op: 'commits',
			commits: [{ sha, short: 'aaaaaaa', subject: 'Fix it' }],
			total: 120,
		})
	})

	it('compares a branch from its fork point and marks whitespace-only files', async () => {
		const seen: string[] = []
		const run = fake({
			'rev-parse --is-inside-work-tree': 'true\n',
			'merge-base dev HEAD': 'f00dfeed\n',
			'diff --numstat': '0\t0\tspace.ts\0',
			'diff --name-status': 'M\0space.ts\0',
			'ls-files': '',
		})
		const compare = createProjectCompare({
			run: async (args, cwd, limits) => {
				seen.push(args.join(' '))
				return run(args, cwd, limits)
			},
		})
		const reply = await compare('/p', {
			op: 'changes',
			base: { kind: 'branch', ref: 'dev' },
			hideWhitespace: true,
		})
		expect(reply).toMatchObject({
			op: 'changes',
			files: [{ path: 'space.ts', status: 'modified', whitespaceOnly: true }],
		})
		expect(seen.some((line) => line.includes('-w f00dfeed'))).toBe(true)
	})

	it('reports a branch that cannot be compared', async () => {
		const compare = createProjectCompare({
			run: fake({ 'rev-parse --is-inside-work-tree': 'true\n' }),
		})
		await expect(
			compare('/p', { op: 'changes', base: { kind: 'branch', ref: 'gone' } }),
		).rejects.toThrow('Couldn’t compare with gone.')
	})
})
