import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	INDEX_MAX_PATHS,
	ProjectFiles,
	confineProjectPath,
	parseFrontmatter,
	resolveProjectLinks,
	setFileSortLocale,
} from './project-files.js'

let outside: string
let root: string
const files = new ProjectFiles()

const put = (relative: string, content: string | Uint8Array = 'x') => {
	const target = join(root, relative)
	mkdirSync(join(target, '..'), { recursive: true })
	writeFileSync(target, content)
}

beforeEach(() => {
	const base = mkdtempSync(join(tmpdir(), 'namzu-files-'))
	outside = join(base, 'outside')
	mkdirSync(outside)
	writeFileSync(join(outside, 'secret.txt'), 'secret')
	mkdirSync(join(base, 'project'))
	root = realpathSync(join(base, 'project'))
})
afterEach(() => {
	rmSync(join(root, '..'), { recursive: true, force: true })
})

describe('path confinement', () => {
	const refused: [string, string][] = [
		['parent segment', '../outside/secret.txt'],
		['parent in the middle', 'a/../../outside/secret.txt'],
		['bare parent', '..'],
		['absolute posix', '/etc/passwd'],
		['absolute posix to the outside file', '/outside/secret.txt'],
		['home shortcut', '~/secret'],
		['bare home', '~'],
		['drive letter', 'C:/Windows/win.ini'],
		['drive letter backslash', 'C:\\Windows\\win.ini'],
		['drive relative', 'C:win.ini'],
		['UNC', '\\\\server\\share\\file'],
		['UNC with slashes', '//server/share/file'],
		['extended path prefix', '\\\\?\\C:\\Windows'],
		['backslash separator', 'a\\b'],
		['NUL', 'a\0b'],
		['newline', 'a\nb'],
		['escape character', 'a\u001bb'],
		['delete character', 'a\u007fb'],
		['not a string', 42 as unknown as string],
		['too long', 'a'.repeat(5000)],
		['git directory', '.git/config'],
		['nested git directory', 'a/.git/config'],
	]
	for (const [name, path] of refused)
		it(`refuses ${name}`, async () => {
			await expect(confineProjectPath(root, path)).rejects.toThrow()
		})

	it('keeps error text free of any path', async () => {
		const error = await confineProjectPath(root, '../outside/secret.txt').catch((e: Error) => e)
		expect((error as Error).message).not.toContain('outside')
		expect((error as Error).message).not.toContain(root)
	})

	it('accepts a plain relative path and normalises dot and empty segments', async () => {
		put('docs/readme.md')
		const result = await confineProjectPath(root, './docs//readme.md')
		expect(result.relative).toBe('docs/readme.md')
		expect(result.absolute).toBe(join(root, 'docs', 'readme.md'))
	})

	it('treats the empty path as the root', async () => {
		const result = await confineProjectPath(root, '')
		expect(result.relative).toBe('')
		expect(result.absolute).toBe(root)
	})

	it('refuses a symlink that leaves the root, file or directory', async () => {
		symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
		symlinkSync(outside, join(root, 'linkdir'))
		await expect(confineProjectPath(root, 'link.txt')).rejects.toThrow()
		await expect(confineProjectPath(root, 'linkdir')).rejects.toThrow()
		await expect(confineProjectPath(root, 'linkdir/secret.txt')).rejects.toThrow()
	})

	it('allows a symlink that stays inside the root', async () => {
		put('real.txt', 'hello')
		symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
		const result = await confineProjectPath(root, 'alias.txt')
		expect(result.absolute).toBe(join(root, 'real.txt'))
	})

	it('does not mistake a sibling that shares the root as a prefix', async () => {
		const sibling = `${root}-sibling`
		mkdirSync(sibling)
		writeFileSync(join(sibling, 'x.txt'), 'x')
		symlinkSync(join(sibling, 'x.txt'), join(root, 'sib.txt'))
		await expect(confineProjectPath(root, 'sib.txt')).rejects.toThrow()
		rmSync(sibling, { recursive: true, force: true })
	})

	it('reports a missing path as missing, not as a path', async () => {
		await expect(confineProjectPath(root, 'nope.txt')).rejects.toThrow(/not found/i)
	})
})

describe('listing', () => {
	it('lists directories first, then files, in natural order', async () => {
		put('b.txt')
		put('a10.txt')
		put('a2.txt')
		put('zdir/inner.txt')
		put('Adir/inner.txt')
		const list = await files.list(root, '')
		expect(list.map((entry) => `${entry.kind}:${entry.name}`)).toEqual([
			'directory:Adir',
			'directory:zdir',
			'file:a2.txt',
			'file:a10.txt',
			'file:b.txt',
		])
		expect(list.find((entry) => entry.name === 'inner.txt')).toBeUndefined()
	})

	it('returns project-relative paths with forward slashes', async () => {
		put('src/deep/file.ts')
		const list = await files.list(root, 'src/deep')
		expect(list).toEqual([{ name: 'file.ts', path: 'src/deep/file.ts', kind: 'file' }])
	})

	it('hides .git, node_modules and ignored paths from nested ignore files', async () => {
		put('.git/HEAD')
		put('node_modules/x/index.js')
		put('.gitignore', 'dist/\n*.log\n')
		put('dist/out.js')
		put('keep.txt')
		put('debug.log')
		put('pkg/.gitignore', 'secret.txt\n!keep.log\n')
		put('pkg/secret.txt')
		put('pkg/open.txt')
		put('pkg/keep.log')
		expect((await files.list(root, '')).map((entry) => entry.name)).toEqual([
			'pkg',
			'.gitignore',
			'keep.txt',
		])
		expect((await files.list(root, 'pkg')).map((entry) => entry.name)).toEqual([
			'.gitignore',
			'keep.log',
			'open.txt',
		])
	})

	it('honours .git/info/exclude', async () => {
		put('.git/info/exclude', 'private.txt\n')
		put('private.txt')
		put('public.txt')
		expect((await files.list(root, '')).map((entry) => entry.name)).toEqual(['public.txt'])
	})

	it('refuses to list inside an ignored or hidden directory', async () => {
		put('.gitignore', 'dist/\n')
		put('dist/out.js')
		put('node_modules/a.js')
		await expect(files.list(root, 'dist')).rejects.toThrow()
		await expect(files.list(root, 'node_modules')).rejects.toThrow()
		await expect(files.list(root, '.git')).rejects.toThrow()
	})

	it('refuses a file where a directory is required', async () => {
		put('a.txt')
		await expect(files.list(root, 'a.txt')).rejects.toThrow(/folder/i)
	})

	it('hides symlinks that leave the root', async () => {
		put('in.txt')
		symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
		symlinkSync(outside, join(root, 'leakdir'))
		expect((await files.list(root, '')).map((entry) => entry.name)).toEqual(['in.txt'])
	})

	it('caps a listing at 5,000 entries', async () => {
		mkdirSync(join(root, 'many'))
		for (let index = 0; index < 5_050; index++) writeFileSync(join(root, 'many', `f${index}`), '')
		expect(await files.list(root, 'many')).toHaveLength(5_000)
	})
})

describe('file index', () => {
	it('walks with the same rules and reports every file path', async () => {
		put('.gitignore', 'dist/\n')
		put('dist/a.js')
		put('node_modules/a.js')
		put('src/a.ts')
		put('src/deep/b.ts')
		symlinkSync(outside, join(root, 'leakdir'))
		const index = await new ProjectFiles().index(root)
		expect(index.truncated).toBe(false)
		expect([...index.paths].sort()).toEqual(['.gitignore', 'src/a.ts', 'src/deep/b.ts'])
	})

	it('stops at the path cap and says so', async () => {
		put('a/1')
		put('a/2')
		put('a/3')
		const index = await new ProjectFiles({ maxPaths: 2 }).index(root)
		expect(index.paths).toHaveLength(2)
		expect(index.truncated).toBe(true)
		expect(INDEX_MAX_PATHS).toBe(50_000)
	})

	it('does not descend past the depth cap', async () => {
		put('d1/d2/d3/file.txt')
		put('top.txt')
		const index = await new ProjectFiles({ maxDepth: 2 }).index(root)
		expect(index.paths).toEqual(['top.txt'])
		expect(index.truncated).toBe(true)
	})

	it('stops when the time budget is spent, using an injected clock', async () => {
		put('a/1')
		put('b/2')
		put('c/3')
		let now = 0
		const slow = new ProjectFiles({
			now: () => {
				now += 2_000
				return now
			},
			budgetMs: 3_000,
		})
		const index = await slow.index(root)
		expect(index.truncated).toBe(true)
		expect(index.paths.length).toBeLessThan(3)
	})

	it('serves a cached index for 30 seconds, then walks again', async () => {
		put('a.txt')
		let now = 1_000
		const cached = new ProjectFiles({ now: () => now })
		expect((await cached.index(root)).paths).toEqual(['a.txt'])
		put('b.txt')
		now += 29_000
		expect((await cached.index(root)).paths).toEqual(['a.txt'])
		now += 2_000
		expect((await cached.index(root)).paths.sort()).toEqual(['a.txt', 'b.txt'])
	})
})

describe('reading', () => {
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

	it('returns text', async () => {
		put('a.txt', 'héllo\n')
		expect(await files.read(root, 'a.txt')).toEqual({
			path: 'a.txt',
			size: Buffer.byteLength('héllo\n'),
			kind: 'text',
			text: 'héllo\n',
		})
	})

	it('treats invalid UTF-8 as binary', async () => {
		put('bad.txt', Buffer.from([0xff, 0xfe, 0x41]))
		expect((await files.read(root, 'bad.txt')).kind).toBe('binary')
	})

	it('treats a NUL byte as binary', async () => {
		put('nul.txt', Buffer.from('ab\0cd'))
		expect((await files.read(root, 'nul.txt')).kind).toBe('binary')
	})

	it('returns a sniffed raster image as a data URL', async () => {
		put('pic.png', png)
		const result = await files.read(root, 'pic.png')
		expect(result.kind).toBe('image')
		expect(result.image).toBe(`data:image/png;base64,${png.toString('base64')}`)
	})

	it('does not trust the extension for images', async () => {
		put('pic.png', 'just text')
		expect((await files.read(root, 'pic.png')).kind).toBe('text')
	})

	it('refuses text above 2 MiB and images above 4 MiB without reading them', async () => {
		put('big.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
		const big = await files.read(root, 'big.txt')
		expect(big).toEqual({ path: 'big.txt', size: 2 * 1024 * 1024 + 1, kind: 'too-large' })
		put('huge.png', Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]))
		expect((await files.read(root, 'huge.png')).kind).toBe('too-large')
	})

	it('accepts text of exactly 2 MiB', async () => {
		put('edge.txt', Buffer.alloc(2 * 1024 * 1024, 0x61))
		expect((await files.read(root, 'edge.txt')).kind).toBe('text')
	})

	it('reads regular files only', async () => {
		mkdirSync(join(root, 'dir'))
		await expect(files.read(root, 'dir')).rejects.toThrow(/file/i)
		await expect(files.read(root, '')).rejects.toThrow()
	})

	it('refuses a symlink to an outside file', async () => {
		symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
		await expect(files.read(root, 'link.txt')).rejects.toThrow()
	})

	it('splits Markdown into a metadata table and a body', async () => {
		put(
			'doc.md',
			'---\ntitle: Hello\ncount: 3\ntags: [a, b]\nnested:\n  k: v\nnone:\n---\n# Body\n',
		)
		const result = await files.read(root, 'doc.md')
		expect(result.kind).toBe('text')
		expect(result.markdown).toBe('# Body\n')
		expect(result.frontmatter).toEqual([
			{ key: 'title', value: 'Hello' },
			{ key: 'count', value: '3' },
			{ key: 'tags', value: '["a","b"]' },
			{ key: 'nested', value: '{"k":"v"}' },
			{ key: 'none', value: 'null' },
		])
		expect(result.text).toContain('title: Hello')
	})

	it('leaves Markdown without a leading block alone', async () => {
		put('plain.md', '# Title\n\n---\nnot: frontmatter\n---\n')
		const result = await files.read(root, 'plain.md')
		expect(result.frontmatter).toBeUndefined()
		expect(result.markdown).toBe('# Title\n\n---\nnot: frontmatter\n---\n')
	})

	it('does not parse front matter in a non-Markdown file', async () => {
		put('a.txt', '---\na: 1\n---\nbody')
		expect((await files.read(root, 'a.txt')).frontmatter).toBeUndefined()
	})
})

describe('front matter', () => {
	it('keeps the raw block when YAML does not parse', () => {
		const result = parseFrontmatter('---\na: [unclosed\n---\nbody')
		expect(result?.frontmatter).toEqual([{ key: 'frontmatter', value: 'a: [unclosed' }])
		expect(result?.markdown).toBe('body')
	})

	it('keeps the raw block when the document is not a mapping', () => {
		const result = parseFrontmatter('---\n- a\n- b\n---\nbody')
		expect(result?.frontmatter).toEqual([{ key: 'frontmatter', value: '- a\n- b' }])
	})

	it('survives an alias bomb without expanding it', () => {
		const lines = ['a: &a [x, x, x, x, x, x, x, x, x]']
		for (let level = 0; level < 9; level++) {
			const previous = String.fromCharCode(97 + level)
			const next = String.fromCharCode(98 + level)
			const refs = Array.from({ length: 9 }, () => `*${previous}`).join(', ')
			lines.push(`${next}: &${next} [${refs}]`)
		}
		const started = process.hrtime.bigint()
		const result = parseFrontmatter(`---\n${lines.join('\n')}\n---\nbody`)
		expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(5_000)
		expect(result?.frontmatter).toHaveLength(1)
		expect(result?.frontmatter?.[0]?.key).toBe('frontmatter')
		expect(result?.markdown).toBe('body')
	})

	it('accepts a Windows line ending and a byte order mark', () => {
		const result = parseFrontmatter('\uFEFF---\r\ntitle: T\r\n---\r\nbody\r\n')
		expect(result?.frontmatter).toEqual([{ key: 'title', value: 'T' }])
		expect(result?.markdown).toBe('body\r\n')
	})

	it('ignores a block that never closes', () => {
		expect(parseFrontmatter('---\ntitle: T\nbody')).toBeUndefined()
	})

	it('bounds the rows and the length of a value', () => {
		const rows = Array.from({ length: 300 }, (_, index) => `k${index}: ${'v'.repeat(10)}`)
		expect(parseFrontmatter(`---\n${rows.join('\n')}\n---\n`)?.frontmatter).toHaveLength(200)
		const long = parseFrontmatter(`---\nk: ${'v'.repeat(9_000)}\n---\n`)
		expect(long?.frontmatter?.[0]?.value.length).toBeLessThanOrEqual(4_000)
	})
})

describe('link resolution', () => {
	const resolve = (refs: string[], roots = [root]) => resolveProjectLinks(roots, refs)

	beforeEach(() => {
		put('docs/guide.md', '# g')
		put('src/a.ts', 'x')
		mkdirSync(join(root, 'docs', 'sub'))
	})

	it('resolves a relative path, with line suffixes', async () => {
		expect(
			await resolve([
				'docs/guide.md',
				'src/a.ts:12',
				'src/a.ts:12:5',
				'src/a.ts#L7',
				'src/a.ts#L7-L9',
				'./src/a.ts',
			]),
		).toEqual([
			{ ref: 'docs/guide.md', path: 'docs/guide.md' },
			{ ref: 'src/a.ts:12', path: 'src/a.ts', line: 12 },
			{ ref: 'src/a.ts:12:5', path: 'src/a.ts', line: 12 },
			{ ref: 'src/a.ts#L7', path: 'src/a.ts', line: 7 },
			{ ref: 'src/a.ts#L7-L9', path: 'src/a.ts', line: 7 },
			{ ref: './src/a.ts', path: 'src/a.ts' },
		])
	})

	it('strips a suffix only when the stripped path exists', async () => {
		put('odd:5', 'file whose name looks like a line')
		expect(await resolve(['odd:5', 'missing.ts:5', 'missing.ts#L5'])).toEqual([
			{ ref: 'odd:5', path: 'odd:5' },
			{ ref: 'missing.ts:5' },
			{ ref: 'missing.ts#L5' },
		])
	})

	it('accepts an absolute path and a file URL inside the root', async () => {
		const absolute = join(root, 'src', 'a.ts')
		const url = new URL(`file://${absolute}`).href
		expect(await resolve([absolute, `${absolute}:3`, url, `${url}#L4`])).toEqual([
			{ ref: absolute, path: 'src/a.ts' },
			{ ref: `${absolute}:3`, path: 'src/a.ts', line: 3 },
			{ ref: url, path: 'src/a.ts' },
			{ ref: `${url}#L4`, path: 'src/a.ts', line: 4 },
		])
	})

	it('accepts the project path as the user typed it when it is a symlink', async () => {
		const alias = `${root}-alias`
		symlinkSync(root, alias)
		const typed = join(alias, 'src', 'a.ts')
		expect(await resolve([typed], [root, alias])).toEqual([{ ref: typed, path: 'src/a.ts' }])
		rmSync(alias)
	})

	it('reveals nothing outside the root', async () => {
		symlinkSync(join(outside, 'secret.txt'), join(root, 'leak.txt'))
		const refs = [
			join(outside, 'secret.txt'),
			`file://${join(outside, 'secret.txt')}`,
			'../outside/secret.txt',
			'leak.txt',
			'/etc/passwd',
			'file://server/share/x',
			'C:\\Windows\\win.ini',
			'\\\\server\\share\\x',
			'~/x',
			'https://example.com/a.ts',
			'',
			'docs',
			'docs/sub',
		]
		for (const result of await resolve(refs)) {
			expect(result.path).toBeUndefined()
			expect(result.line).toBeUndefined()
		}
	})

	it('refuses more than 200 refs, a long ref and a non-array', async () => {
		await expect(resolve(Array.from({ length: 201 }, () => 'a'))).rejects.toThrow()
		expect(await resolve(['a'.repeat(5_000)])).toEqual([{ ref: 'a'.repeat(5_000) }])
		await expect(resolveProjectLinks([root], 'x' as unknown as string[])).rejects.toThrow()
	})
})

describe('reading ignored files', () => {
	it('refuses a file the listing hides, by exact path', async () => {
		put('.gitignore', '.env\nsecrets/\n')
		put('.env', 'TOKEN=1')
		put('secrets/key.txt')
		put('node_modules/x/index.js')
		put('.git/info/exclude', 'private.txt\n')
		put('private.txt')
		put('open.txt', 'fine')
		for (const path of ['.env', 'secrets/key.txt', 'node_modules/x/index.js', 'private.txt'])
			await expect(files.read(root, path), path).rejects.toThrow('ignore rules')
		expect((await files.read(root, 'open.txt')).text).toBe('fine')
	})

	it('refuses a link inside the project that points at an ignored file', async () => {
		put('.gitignore', '.env\n')
		put('.env', 'TOKEN=1')
		symlinkSync(join(root, '.env'), join(root, 'innocent.txt'))
		await expect(files.read(root, 'innocent.txt')).rejects.toThrow('ignore rules')
	})

	it('does not turn an ignored file into a link', async () => {
		put('.gitignore', '.env\n')
		put('.env')
		put('a.txt')
		const result = await resolveProjectLinks([root], ['.env', 'a.txt'])
		expect(result.map((r) => r.path)).toEqual([undefined, 'a.txt'])
	})
})

describe('index limits inside one folder', () => {
	it('stops reading one huge folder at the path cap and says so', async () => {
		for (let i = 0; i < 20; i++) put(`big/f${i}`)
		const small = new ProjectFiles({ maxPaths: 5 })
		const index = await small.index(root)
		expect(index.paths).toHaveLength(5)
		expect(index.truncated).toBe(true)
	})

	it('forgets the cache on invalidate so new files show at once', async () => {
		put('a.txt')
		await files.index(root)
		put('b.txt')
		files.invalidate(root)
		expect((await files.index(root)).paths).toContain('b.txt')
	})
})

describe('read hardening', () => {
	it.skipIf(process.platform === 'win32')(
		'refuses a named pipe instead of waiting for a writer',
		async () => {
			execFileSync('mkfifo', [join(root, 'pipe')])
			// Awaited directly: a regression hangs until the test runner's own timeout.
			await expect(files.read(root, 'pipe')).rejects.toThrow('not a file')
		},
	)
})

describe('sorting by the app language', () => {
	afterEach(() => setFileSortLocale(undefined))
	const names = [
		'Zeytin.txt',
		'Şeker.txt',
		'Sat.txt',
		'Çalışma.txt',
		'Cam.txt',
		'Öğrenci.txt',
		'Oda.txt',
	]
	it('puts Turkish letters after their plain neighbours in a Turkish app', async () => {
		setFileSortLocale('tr')
		for (const name of names) put(name)
		expect((await files.list(root, '')).map((entry) => entry.name)).toEqual([
			'Cam.txt',
			'Çalışma.txt',
			'Oda.txt',
			'Öğrenci.txt',
			'Sat.txt',
			'Şeker.txt',
			'Zeytin.txt',
		])
	})
	it('keeps dotless and dotted i as different names', async () => {
		setFileSortLocale('tr')
		put('ışık.txt')
		put('isik.txt')
		expect((await files.list(root, '')).map((entry) => entry.name)).toEqual([
			'ışık.txt',
			'isik.txt',
		])
	})
	it('falls back to the system order when the locale is not valid', async () => {
		setFileSortLocale('not a locale!!')
		put('b.txt')
		put('a.txt')
		expect((await files.list(root, '')).map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
	})
})
