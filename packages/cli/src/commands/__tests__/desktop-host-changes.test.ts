import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import {
	CHANGES_MAX_FILES,
	CHANGES_TIMEOUT_MS,
	CHANGES_UNTRACKED_COUNTED,
	DIFF_TEXT_MAX_BYTES,
	countLines,
	createProjectChanges,
	parseNameStatus,
	parseNumstat,
	projectPathSegments,
} from '../desktop-host-changes.js'
import { type GitRunBytes, runGitBytes } from '../desktop-host-header.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

const nul = (...parts: string[]) => Buffer.from(`${parts.join('\0')}\0`)

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-desktop-changes-'))
	cwd = join(root, 'project')
	mkdirSync(cwd, { recursive: true })
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

describe('numstat and name-status parsing', () => {
	it('reads plain, renamed and binary records of the -z format', () => {
		const rows = parseNumstat(
			nul(
				'3\t1\ta.ts',
				'0\t0\t',
				'old name.md',
				'new name.md',
				'-\t-\timg.png',
				'12\t0\tsp ace/b.ts',
			),
		)
		expect(rows).toEqual([
			{ path: 'a.ts', added: 3, removed: 1, binary: false },
			{
				path: 'new name.md',
				oldPath: 'old name.md',
				added: 0,
				removed: 0,
				binary: false,
			},
			{ path: 'img.png', added: 0, removed: 0, binary: true },
			{ path: 'sp ace/b.ts', added: 12, removed: 0, binary: false },
		])
	})

	it('drops a record cut in half by the output cap', () => {
		const cut = Buffer.concat([nul('1\t1\ta.ts'), Buffer.from('2\t2\tb.t')])
		expect(parseNumstat(cut, true).map((row) => row.path)).toEqual(['a.ts'])
		const renameCut = Buffer.from('1\t1\ta.ts\0' + '0\t0\t\0old\0')
		expect(parseNumstat(renameCut, true).map((row) => row.path)).toEqual(['a.ts'])
		expect(parseNumstat(Buffer.alloc(0))).toEqual([])
	})

	it('reads status letters and the old path of a rename', () => {
		const map = parseNameStatus(
			nul('M', 'a.ts', 'A', 'b.ts', 'D', 'c.ts', 'R087', 'old.ts', 'new.ts'),
		)
		expect(map.get('a.ts')?.letter).toBe('M')
		expect(map.get('b.ts')?.letter).toBe('A')
		expect(map.get('c.ts')?.letter).toBe('D')
		expect(map.get('new.ts')).toEqual({ letter: 'R', oldPath: 'old.ts' })
		expect(map.has('old.ts')).toBe(false)
	})

	it('counts lines the way a diff would', () => {
		expect(countLines('')).toBe(0)
		expect(countLines('a')).toBe(1)
		expect(countLines('a\n')).toBe(1)
		expect(countLines('a\nb')).toBe(2)
		expect(countLines('\n\n')).toBe(2)
	})
})

describe('path confinement text rules', () => {
	it.each([
		'',
		'../x',
		'a/../../x',
		'/etc/passwd',
		'C:/x',
		'.git/config',
		'a/.GIT/config',
		'~/x',
		'a\u0000b',
		'a\nb',
		'x'.repeat(1025),
		'bad\uFFFDname',
	])('refuses %j', (path) => {
		expect(projectPathSegments(path)).toBeNull()
	})
	it('treats a backslash as a separator only on Windows', () => {
		expect(projectPathSegments('a\\b')).toEqual(process.platform === 'win32' ? null : ['a\\b'])
	})
	it('accepts an ordinary relative path', () => {
		expect(projectPathSegments('src/./a b/c.ts')).toEqual(['src', 'a b', 'c.ts'])
	})
})

/** A scripted git: answers by the subcommand, records every call. */
function scripted(answers: {
	inside?: boolean | 'slow'
	head?: boolean
	numstat?: Buffer
	nameStatus?: Buffer
	others?: Buffer
	shown?: Record<string, Buffer>
	cap?: Partial<Record<'numstat' | 'others', boolean>>
}) {
	const calls: {
		args: readonly string[]
		limits: { maxBytes: number; timeoutMs: number }
	}[] = []
	const run: GitRunBytes = async (args, _cwd, limits) => {
		calls.push({ args, limits })
		const empty = { data: Buffer.alloc(0), truncated: false }
		if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
			if (answers.inside === 'slow') throw Object.assign(new Error('timed out'), { killed: true })
			if (answers.inside === false) throw Object.assign(new Error('not a repo'), { code: 128 })
			return { data: Buffer.from('true\n'), truncated: false }
		}
		if (args[0] === 'rev-parse') {
			if (answers.head === false) throw Object.assign(new Error('no head'), { code: 1 })
			return { data: Buffer.from('abc\n'), truncated: false }
		}
		if (args[0] === 'diff' && args[1] === '--numstat')
			return {
				data: answers.numstat ?? Buffer.alloc(0),
				truncated: answers.cap?.numstat === true,
			}
		if (args[0] === 'diff') return { data: answers.nameStatus ?? Buffer.alloc(0), truncated: false }
		if (args[0] === 'ls-files')
			return {
				data: answers.others ?? Buffer.alloc(0),
				truncated: answers.cap?.others === true,
			}
		if (args[0] === 'cat-file') {
			const hit = answers.shown?.[String(args[2])]
			if (!hit) throw Object.assign(new Error('missing'), { code: 128 })
			return { data: hit, truncated: hit.length > limits.maxBytes }
		}
		return empty
	}
	return { run, calls }
}

describe('changes', () => {
	it('answers null outside a repository and when git is missing', async () => {
		const outside = scripted({ inside: false })
		expect(await createProjectChanges({ run: outside.run }).changes(cwd)).toBeNull()
		const missing: GitRunBytes = async () => {
			throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
		}
		expect(await createProjectChanges({ run: missing }).changes(cwd)).toBeNull()
	})

	it('reports a timeout as an error, never as an empty list', async () => {
		const slow = scripted({ inside: 'slow' })
		await expect(createProjectChanges({ run: slow.run }).changes(cwd)).rejects.toThrow('too long')
		const hung: GitRunBytes = async (args) => {
			if (args[0] === 'diff') throw Object.assign(new Error('x'), { signal: 'SIGTERM' })
			return { data: Buffer.from('true\n'), truncated: false }
		}
		await expect(createProjectChanges({ run: hung }).changes(cwd)).rejects.toThrow('too long')
	})

	it('gives every git call a timeout and an output cap, with no shell-ish arguments', async () => {
		const git = scripted({})
		await createProjectChanges({ run: git.run }).changes(cwd)
		expect(git.calls.length).toBeGreaterThan(3)
		for (const call of git.calls) {
			expect(call.limits.timeoutMs).toBe(CHANGES_TIMEOUT_MS)
			expect(call.limits.maxBytes).toBeGreaterThan(0)
		}
		const diffs = git.calls.filter((call) => call.args[0] === 'diff')
		for (const call of diffs) {
			expect(call.args).toContain('-z')
			expect(call.args).toContain('--no-ext-diff')
			expect(call.args).toContain('--no-textconv')
			expect(call.args).toContain('--relative')
			expect(call.args.at(-1)).toBe('--')
		}
	})

	it('merges status and counts, marks binary, and lists renames with their old path', async () => {
		const git = scripted({
			numstat: nul(
				'3\t1\ta.ts',
				'0\t0\t',
				'old.md',
				'new.md',
				'-\t-\timg.png',
				'0\t7\tgone.ts',
				'5\t0\tnew.ts',
				'-\t-\t',
				'a.png',
				'b.png',
			),
			nameStatus: nul(
				'M',
				'a.ts',
				'R100',
				'old.md',
				'new.md',
				'M',
				'img.png',
				'D',
				'gone.ts',
				'A',
				'new.ts',
				'R100',
				'a.png',
				'b.png',
			),
		})
		const result = await createProjectChanges({ run: git.run }).changes(cwd)
		expect(result).toEqual({
			truncated: false,
			files: [
				{ path: 'a.ts', status: 'modified', added: 3, removed: 1 },
				{
					path: 'b.png',
					status: 'renamed',
					added: 0,
					removed: 0,
					oldPath: 'a.png',
					binary: true,
				},
				{ path: 'gone.ts', status: 'deleted', added: 0, removed: 7 },
				{ path: 'img.png', status: 'binary', added: 0, removed: 0 },
				{
					path: 'new.md',
					status: 'renamed',
					added: 0,
					removed: 0,
					oldPath: 'old.md',
				},
				{ path: 'new.ts', status: 'added', added: 5, removed: 0 },
			],
		})
	})

	it('compares against the empty tree before the first commit', async () => {
		const git = scripted({ head: false })
		await createProjectChanges({ run: git.run }).changes(cwd)
		const numstat = git.calls.find((call) => call.args[1] === '--numstat')
		expect(numstat?.args).toContain('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
		expect(numstat?.args).not.toContain('HEAD')
	})

	it('skips paths git could not have produced and marks a capped stream truncated', async () => {
		const git = scripted({
			numstat: nul('1\t1\t../escape', '1\t1\t.git/config', '2\t2\tok.ts'),
			cap: { numstat: true },
		})
		const result = await createProjectChanges({ run: git.run }).changes(cwd)
		expect(result?.files.map((file) => file.path)).toEqual(['ok.ts'])
		expect(result?.truncated).toBe(true)
	})

	it('counts untracked lines for text, flags binary, and does not follow links', async () => {
		writeFileSync(join(cwd, 'notes.txt'), 'one\ntwo\nthree')
		writeFileSync(join(cwd, 'blob.bin'), Buffer.from([1, 0, 2]))
		writeFileSync(join(cwd, 'latin.txt'), Buffer.from([0xe9, 0x0a]))
		writeFileSync(join(root, 'secret.txt'), 'a\nb\nc\nd\n')
		symlinkSync(join(root, 'secret.txt'), join(cwd, 'link.txt'))
		const git = scripted({
			others: nul('blob.bin', 'latin.txt', 'link.txt', 'notes.txt', 'missing.txt'),
		})
		const result = await createProjectChanges({ run: git.run }).changes(cwd)
		expect(result?.files).toEqual([
			{ path: 'blob.bin', status: 'binary', added: 0, removed: 0 },
			{ path: 'latin.txt', status: 'binary', added: 0, removed: 0 },
			{ path: 'link.txt', status: 'untracked', added: 0, removed: 0 },
			{ path: 'missing.txt', status: 'untracked', added: 0, removed: 0 },
			{ path: 'notes.txt', status: 'untracked', added: 3, removed: 0 },
		])
	})

	it('counts lines for only the first untracked files and lists the rest as new', async () => {
		const names = Array.from(
			{ length: CHANGES_UNTRACKED_COUNTED + 5 },
			(_, n) => `f${String(n).padStart(4, '0')}.txt`,
		)
		for (const name of names) writeFileSync(join(cwd, name), 'x\n')
		const git = scripted({ others: nul(...names) })
		const result = await createProjectChanges({ run: git.run }).changes(cwd)
		const counted = result?.files.filter((file) => file.added === 1) ?? []
		expect(counted).toHaveLength(CHANGES_UNTRACKED_COUNTED)
		expect(result?.files).toHaveLength(names.length)
		expect(result?.files.at(-1)).toEqual({
			path: names.at(-1),
			status: 'untracked',
			added: 0,
			removed: 0,
		})
		expect(result?.truncated).toBe(false)
	})

	it('lists untracked files too large to count without reading them into the answer', async () => {
		writeFileSync(join(cwd, 'big.txt'), Buffer.alloc(DIFF_TEXT_MAX_BYTES + 1, 0x61))
		const git = scripted({ others: nul('big.txt') })
		const result = await createProjectChanges({ run: git.run }).changes(cwd)
		expect(result?.files).toEqual([{ path: 'big.txt', status: 'untracked', added: 0, removed: 0 }])
	})

	it('caps the list at the file limit and says so', async () => {
		const tracked = Array.from(
			{ length: CHANGES_MAX_FILES - 1 },
			(_, n) => `1\t0\tt${String(n).padStart(5, '0')}.ts`,
		)
		const git = scripted({
			numstat: nul(...tracked),
			others: nul('u1.txt', 'u2.txt', 'u3.txt'),
		})
		const result = await createProjectChanges({ run: git.run }).changes(cwd)
		expect(result?.files).toHaveLength(CHANGES_MAX_FILES)
		expect(result?.truncated).toBe(true)
		const exact = scripted({ numstat: nul(...tracked), others: nul('u1.txt') })
		const fits = await createProjectChanges({ run: exact.run }).changes(cwd)
		expect(fits?.files).toHaveLength(CHANGES_MAX_FILES)
		expect(fits?.truncated).toBe(false)
	})
})

describe('diff', () => {
	const blob = (text: string | Buffer) => (typeof text === 'string' ? Buffer.from(text) : text)

	it('refuses paths outside the project before any git or disk read', async () => {
		const git = scripted({})
		const reader = createProjectChanges({ run: git.run })
		for (const path of ['../x', '/etc/passwd', '.git/config', '', 'a/../../x', 7 as never])
			await expect(reader.diff(cwd, path)).rejects.toThrow('not inside this project')
		expect(git.calls).toHaveLength(0)
	})

	it('refuses a link that leaves the project or reaches .git', async () => {
		mkdirSync(join(cwd, '.git'))
		writeFileSync(join(cwd, '.git', 'config'), 'secret')
		writeFileSync(join(root, 'outside.txt'), 'outside')
		symlinkSync(join(root, 'outside.txt'), join(cwd, 'out.txt'))
		symlinkSync(join(cwd, '.git', 'config'), join(cwd, 'cfg.txt'))
		symlinkSync(root, join(cwd, 'up'))
		const git = scripted({})
		const reader = createProjectChanges({ run: git.run })
		for (const path of ['out.txt', 'cfg.txt', 'up/outside.txt'])
			await expect(reader.diff(cwd, path)).rejects.toThrow('not inside this project')
		expect(git.calls).toHaveLength(0)
	})

	it('refuses a folder', async () => {
		mkdirSync(join(cwd, 'dir'))
		await expect(createProjectChanges({ run: scripted({}).run }).diff(cwd, 'dir')).rejects.toThrow(
			'not a file',
		)
	})

	it('returns both sides of a modified file, relative to the folder', async () => {
		writeFileSync(join(cwd, 'a.ts'), 'new\n')
		const git = scripted({ shown: { 'HEAD:./a.ts': blob('old\n') } })
		const diff = await createProjectChanges({ run: git.run }).diff(cwd, 'a.ts')
		expect(diff).toEqual({
			before: 'old\n',
			after: 'new\n',
			binary: false,
			truncated: false,
		})
	})

	it('shows an added file with no before and a deleted file with no after', async () => {
		writeFileSync(join(cwd, 'added.ts'), 'hello')
		const git = scripted({ shown: { 'HEAD:./gone.ts': blob('bye') } })
		const reader = createProjectChanges({ run: git.run })
		expect(await reader.diff(cwd, 'added.ts')).toEqual({
			before: null,
			after: 'hello',
			binary: false,
			truncated: false,
		})
		expect(await reader.diff(cwd, 'gone.ts')).toEqual({
			before: 'bye',
			after: null,
			binary: false,
			truncated: false,
		})
		await expect(reader.diff(cwd, 'nowhere.ts')).rejects.toThrow('not found')
	})

	it('takes the before side of a rename from its old path', async () => {
		writeFileSync(join(cwd, 'new.md'), 'text')
		const git = scripted({
			nameStatus: nul('R090', 'old.md', 'new.md'),
			shown: { 'HEAD:./old.md': blob('text before') },
		})
		const diff = await createProjectChanges({ run: git.run }).diff(cwd, 'new.md')
		expect(diff.before).toBe('text before')
		expect(diff.after).toBe('text')
	})

	it('answers binary for a NUL byte or invalid UTF-8 on either side, without text', async () => {
		writeFileSync(join(cwd, 'a.bin'), Buffer.from([0, 1, 2]))
		writeFileSync(join(cwd, 'b.txt'), 'fine')
		writeFileSync(join(cwd, 'c.txt'), 'fine')
		const git = scripted({
			shown: {
				'HEAD:./b.txt': blob(Buffer.from([0xff, 0xfe, 0x41])),
				'HEAD:./c.txt': blob('ok'),
			},
		})
		const reader = createProjectChanges({ run: git.run })
		const binary = {
			before: null,
			after: null,
			binary: true,
			truncated: false,
		}
		expect(await reader.diff(cwd, 'a.bin')).toEqual(binary)
		expect(await reader.diff(cwd, 'b.txt')).toEqual(binary)
		expect((await reader.diff(cwd, 'c.txt')).binary).toBe(false)
	})

	it('answers truncated for a file over 2 MiB on either side', async () => {
		writeFileSync(join(cwd, 'big.txt'), Buffer.alloc(DIFF_TEXT_MAX_BYTES + 1, 0x61))
		writeFileSync(join(cwd, 'edge.txt'), Buffer.alloc(DIFF_TEXT_MAX_BYTES, 0x61))
		writeFileSync(join(cwd, 'headbig.txt'), 'small')
		const git = scripted({
			shown: {
				'HEAD:./headbig.txt': Buffer.alloc(DIFF_TEXT_MAX_BYTES + 1, 0x61),
			},
		})
		const reader = createProjectChanges({ run: git.run })
		const truncated = {
			before: null,
			after: null,
			binary: false,
			truncated: true,
		}
		expect(await reader.diff(cwd, 'big.txt')).toEqual(truncated)
		expect(await reader.diff(cwd, 'headbig.txt')).toEqual(truncated)
		expect((await reader.diff(cwd, 'edge.txt')).truncated).toBe(false)
	})

	it('reports a git timeout instead of pretending the file is new', async () => {
		writeFileSync(join(cwd, 'a.ts'), 'x')
		const hung: GitRunBytes = async () => {
			throw Object.assign(new Error('x'), { killed: true })
		}
		await expect(createProjectChanges({ run: hung }).diff(cwd, 'a.ts')).rejects.toThrow('too long')
	})
})

describe('against real git', () => {
	const git = (...args: string[]) =>
		execFileSync('git', args, {
			cwd,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 't',
				GIT_AUTHOR_EMAIL: 't@example.com',
				GIT_COMMITTER_NAME: 't',
				GIT_COMMITTER_EMAIL: 't@example.com',
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_SYSTEM: '/dev/null',
			},
			stdio: 'pipe',
		})

	it('reads a repository with a modified, renamed, deleted, binary and untracked file', async () => {
		git('init', '-q')
		const lines = Array.from({ length: 30 }, (_, n) => `line ${n}`).join('\n')
		writeFileSync(join(cwd, 'mod.txt'), 'a\nb\nc\n')
		writeFileSync(join(cwd, 'old name.txt'), `${lines}\n`)
		writeFileSync(join(cwd, 'gone.txt'), 'x\ny\n')
		writeFileSync(join(cwd, 'pic.bin'), Buffer.from([0, 1, 2, 3]))
		git('add', '.')
		git('commit', '-q', '-m', 'init')
		writeFileSync(join(cwd, 'mod.txt'), 'a\nB\nc\nd\n')
		renameSync(join(cwd, 'old name.txt'), join(cwd, 'new name.txt'))
		rmSync(join(cwd, 'gone.txt'))
		writeFileSync(join(cwd, 'pic.bin'), Buffer.from([0, 9, 9, 9, 9]))
		writeFileSync(join(cwd, 'fresh.txt'), 'one\ntwo\n')
		git('add', '-N', 'new name.txt')
		const reader = createProjectChanges()
		const result = await reader.changes(cwd)
		const byPath = Object.fromEntries((result?.files ?? []).map((file) => [file.path, file]))
		expect(byPath['mod.txt']).toMatchObject({
			status: 'modified',
			added: 2,
			removed: 1,
		})
		expect(byPath['gone.txt']).toMatchObject({ status: 'deleted', removed: 2 })
		expect(byPath['pic.bin']).toMatchObject({ status: 'binary' })
		expect(byPath['fresh.txt']).toEqual({
			path: 'fresh.txt',
			status: 'untracked',
			added: 2,
			removed: 0,
		})
		expect(
			byPath['new name.txt']?.oldPath === 'old name.txt' ||
				byPath['new name.txt']?.status === 'added',
		).toBe(true)
		expect(await reader.diff(cwd, 'mod.txt')).toEqual({
			before: 'a\nb\nc\n',
			after: 'a\nB\nc\nd\n',
			binary: false,
			truncated: false,
		})
		expect((await reader.diff(cwd, 'gone.txt')).after).toBeNull()
		expect((await reader.diff(cwd, 'pic.bin')).binary).toBe(true)
	})

	it('answers null in a folder that is not a repository, and works before the first commit', async () => {
		const plain = mkdtempSync(join(root, 'plain-'))
		expect(await createProjectChanges().changes(plain)).toBeNull()
		git('init', '-q')
		writeFileSync(join(cwd, 'a.txt'), 'x\n')
		git('add', 'a.txt')
		const result = await createProjectChanges({ run: runGitBytes }).changes(cwd)
		expect(result?.files).toEqual([{ path: 'a.txt', status: 'added', added: 1, removed: 0 }])
	})

	it('lists only the folder it was started in, with paths relative to it', async () => {
		git('init', '-q')
		mkdirSync(join(cwd, 'pkg'))
		writeFileSync(join(cwd, 'top.txt'), '1\n')
		writeFileSync(join(cwd, 'pkg', 'in.txt'), '1\n')
		git('add', '.')
		git('commit', '-q', '-m', 'init')
		writeFileSync(join(cwd, 'top.txt'), '2\n')
		writeFileSync(join(cwd, 'pkg', 'in.txt'), '2\n')
		const result = await createProjectChanges().changes(join(cwd, 'pkg'))
		expect(result?.files.map((file) => file.path)).toEqual(['in.txt'])
		expect((await createProjectChanges().diff(join(cwd, 'pkg'), 'in.txt')).before).toBe('1\n')
	})
})

describe('host methods', () => {
	function host(run: GitRunBytes) {
		mkdirSync(join(root, 'state'), { recursive: true })
		vi.stubEnv('NAMZU_HOME', join(root, 'state'))
		const owner = createCliAcpRuntime(
			{
				config: {},
				formatter: {
					name: 'text',
					print: () => {},
					info: () => {},
					error: () => {},
				},
			},
			{
				decideTrust: decideHeadlessTrust,
				resolveSession: async (sessionId: string) => ({ sessionId }),
			} as unknown as AcpRuntimeDependencies,
		)
		return {
			owner,
			ext: createDesktopHostExtensions(
				owner,
				cwd,
				undefined,
				undefined,
				undefined,
				createProjectChanges({ run }),
			),
		}
	}

	it('answers null and reads nothing until the folder is trusted', async () => {
		const git = scripted({})
		const { owner, ext } = host(git.run)
		try {
			expect(await ext['namzu/project/changes']({})).toBeNull()
			await expect(ext['namzu/project/diff']({ path: 'a.ts' })).rejects.toThrow('Trust this folder')
			expect(git.calls).toHaveLength(0)
		} finally {
			await owner.close()
		}
	})

	it('validates its parameters and answers once trusted', async () => {
		writeFileSync(join(cwd, 'a.ts'), 'now')
		const git = scripted({
			numstat: nul('1\t0\ta.ts'),
			nameStatus: nul('A', 'a.ts'),
		})
		const { owner, ext } = host(git.run)
		ext['namzu/project/trust']({ confirmed: true, cwd })
		try {
			await expect(ext['namzu/project/changes']({ extra: 1 })).rejects.toThrow('Invalid')
			await expect(ext['namzu/project/diff']({})).rejects.toThrow('Invalid')
			await expect(ext['namzu/project/diff']({ path: 'a.ts', more: 1 })).rejects.toThrow('Invalid')
			await expect(ext['namzu/project/diff']({ path: '../x' })).rejects.toThrow('not inside')
			expect(await ext['namzu/project/changes']({})).toEqual({
				files: [{ path: 'a.ts', status: 'added', added: 1, removed: 0 }],
				truncated: false,
			})
			expect(await ext['namzu/project/diff']({ path: 'a.ts' })).toEqual({
				before: null,
				after: 'now',
				binary: false,
				truncated: false,
			})
		} finally {
			await owner.close()
		}
	})
})
