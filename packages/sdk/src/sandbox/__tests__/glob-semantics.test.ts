import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { walkFilesLocally } from '../file-walk.js'

// Pins which files the sandbox file walk returns for representative glob
// patterns, so a change of glob engine cannot silently widen or narrow what
// a search or a listing sees. Expected values were recorded from the engine
// in use before the move off minimatch 9 (GHSA-g3hv-75wg-m249) and are not to
// be re-recorded to make a new engine pass.
const files = [
	'top.ts',
	'.env',
	'.secret.ts',
	'src/one.ts',
	'src/.secret.ts',
	'src/two.js',
	'src/deep/three.ts',
	'src/deep/.hidden/four.ts',
	'src/a/three.ts',
	'a/b/x',
	'c/x',
	'b/x',
	'aa/x',
	'.config/value.json',
	'.config/.secret.ts',
	'x',
	'file[1].txt',
	'a b.md',
	'src/.dotdir/y.ts',
	'.git2/z.ts',
	'ab/x',
]
const dirs: string[] = []
let root = ''
beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-glob-pin-')))
	dirs.push(root)
	for (const file of files) {
		const full = join(root, file)
		await mkdir(join(full, '..'), { recursive: true })
		await writeFile(full, 'x')
	}
})
afterAll(async () => {
	await removeTempDirs(dirs)
})

const patterns = [
	'**/*',
	'**',
	'*.ts',
	'*',
	'src/**/*.ts',
	'src/**',
	'a/b/*',
	'src/*/three.ts',
	'*.{ts,js}',
	'src/{one,two}.*',
	'src/?ne.ts',
	'[ab]/**',
	'[!a]/x',
	'src/**/!(three).ts',
	'+(a|b)/x',
	'@(a|c)/x',
	'.config/*',
	'**/.secret.ts',
	'a/**/x',
	'./top.ts',
	'x',
	'file\\[1\\].txt',
	'*.[jt]s',
	'**/**/x',
	'a/**/**/x',
	'src/deep/**/*.ts',
	'src/',
	'src//one.ts',
	'?(a|b)/x',
	'*(a)/x',
	'[[:alpha:]]/x',
	'[^a]/x',
	's*c/**/t*.ts',
	'src/**/th**.ts',
	'!(src)/x',
	'!(a|b)',
	'src/+([a-z]).ts',
	'a b.md',
	'*[1].txt',
	'file\\[*\\].txt',
	'\\.env',
	'*/*/x',
	'*/.secret.ts',
]
const expected: Record<string, { hidden: string[]; visible: string[] }> = {
	'**/*': {
		visible: [
			'a b.md',
			'a/b/x',
			'aa/x',
			'ab/x',
			'b/x',
			'c/x',
			'file[1].txt',
			'src/a/three.ts',
			'src/deep/three.ts',
			'src/one.ts',
			'src/two.js',
			'top.ts',
			'x',
		],
		hidden: [
			'.config/.secret.ts',
			'.config/value.json',
			'.env',
			'.git2/z.ts',
			'.secret.ts',
			'a b.md',
			'a/b/x',
			'aa/x',
			'ab/x',
			'b/x',
			'c/x',
			'file[1].txt',
			'src/.dotdir/y.ts',
			'src/.secret.ts',
			'src/a/three.ts',
			'src/deep/.hidden/four.ts',
			'src/deep/three.ts',
			'src/one.ts',
			'src/two.js',
			'top.ts',
			'x',
		],
	},
	'**': {
		visible: [
			'a b.md',
			'a/b/x',
			'aa/x',
			'ab/x',
			'b/x',
			'c/x',
			'file[1].txt',
			'src/a/three.ts',
			'src/deep/three.ts',
			'src/one.ts',
			'src/two.js',
			'top.ts',
			'x',
		],
		hidden: [
			'.config/.secret.ts',
			'.config/value.json',
			'.env',
			'.git2/z.ts',
			'.secret.ts',
			'a b.md',
			'a/b/x',
			'aa/x',
			'ab/x',
			'b/x',
			'c/x',
			'file[1].txt',
			'src/.dotdir/y.ts',
			'src/.secret.ts',
			'src/a/three.ts',
			'src/deep/.hidden/four.ts',
			'src/deep/three.ts',
			'src/one.ts',
			'src/two.js',
			'top.ts',
			'x',
		],
	},
	'*.ts': {
		visible: ['top.ts'],
		hidden: ['.secret.ts', 'top.ts'],
	},
	'*': {
		visible: ['a b.md', 'file[1].txt', 'top.ts', 'x'],
		hidden: ['.env', '.secret.ts', 'a b.md', 'file[1].txt', 'top.ts', 'x'],
	},
	'src/**/*.ts': {
		visible: ['src/a/three.ts', 'src/deep/three.ts', 'src/one.ts'],
		hidden: [
			'src/.dotdir/y.ts',
			'src/.secret.ts',
			'src/a/three.ts',
			'src/deep/.hidden/four.ts',
			'src/deep/three.ts',
			'src/one.ts',
		],
	},
	'src/**': {
		visible: ['src/a/three.ts', 'src/deep/three.ts', 'src/one.ts', 'src/two.js'],
		hidden: [
			'src/.dotdir/y.ts',
			'src/.secret.ts',
			'src/a/three.ts',
			'src/deep/.hidden/four.ts',
			'src/deep/three.ts',
			'src/one.ts',
			'src/two.js',
		],
	},
	'a/b/*': {
		visible: ['a/b/x'],
		hidden: ['a/b/x'],
	},
	'src/*/three.ts': {
		visible: ['src/a/three.ts', 'src/deep/three.ts'],
		hidden: ['src/a/three.ts', 'src/deep/three.ts'],
	},
	'*.{ts,js}': {
		visible: ['top.ts'],
		hidden: ['.secret.ts', 'top.ts'],
	},
	'src/{one,two}.*': {
		visible: ['src/one.ts', 'src/two.js'],
		hidden: ['src/one.ts', 'src/two.js'],
	},
	'src/?ne.ts': {
		visible: ['src/one.ts'],
		hidden: ['src/one.ts'],
	},
	'[ab]/**': {
		visible: ['a b.md', 'a/b/x', 'b/x'],
		hidden: ['a b.md', 'a/b/x', 'b/x'],
	},
	'[!a]/x': {
		visible: ['b/x', 'c/x'],
		hidden: ['b/x', 'c/x'],
	},
	'src/**/!(three).ts': {
		visible: ['src/one.ts'],
		hidden: ['src/.dotdir/y.ts', 'src/.secret.ts', 'src/deep/.hidden/four.ts', 'src/one.ts'],
	},
	'+(a|b)/x': {
		visible: ['aa/x', 'ab/x', 'b/x'],
		hidden: ['aa/x', 'ab/x', 'b/x'],
	},
	'@(a|c)/x': {
		visible: ['c/x'],
		hidden: ['c/x'],
	},
	'.config/*': {
		visible: ['.config/value.json'],
		hidden: ['.config/.secret.ts', '.config/value.json'],
	},
	'**/.secret.ts': {
		visible: ['.secret.ts', 'src/.secret.ts'],
		hidden: ['.config/.secret.ts', '.secret.ts', 'src/.secret.ts'],
	},
	'a/**/x': {
		visible: ['a/b/x'],
		hidden: ['a/b/x'],
	},
	'./top.ts': {
		visible: ['top.ts'],
		hidden: ['top.ts'],
	},
	x: {
		visible: ['x'],
		hidden: ['x'],
	},
	'file\\[1\\].txt': {
		visible: ['file[1].txt'],
		hidden: ['file[1].txt'],
	},
	'*.[jt]s': {
		visible: ['top.ts'],
		hidden: ['.secret.ts', 'top.ts'],
	},
	'**/**/x': {
		visible: ['a/b/x', 'aa/x', 'ab/x', 'b/x', 'c/x', 'x'],
		hidden: ['a/b/x', 'aa/x', 'ab/x', 'b/x', 'c/x', 'x'],
	},
	'a/**/**/x': {
		visible: ['a/b/x'],
		hidden: ['a/b/x'],
	},
	'src/deep/**/*.ts': {
		visible: ['src/deep/three.ts'],
		hidden: ['src/deep/.hidden/four.ts', 'src/deep/three.ts'],
	},
	'src/': {
		visible: [],
		hidden: [],
	},
	'src//one.ts': {
		visible: ['src/one.ts'],
		hidden: ['src/one.ts'],
	},
	'?(a|b)/x': {
		visible: ['b/x'],
		hidden: ['b/x'],
	},
	'*(a)/x': {
		visible: ['aa/x'],
		hidden: ['aa/x'],
	},
	'[[:alpha:]]/x': {
		visible: ['b/x', 'c/x'],
		hidden: ['b/x', 'c/x'],
	},
	'[^a]/x': {
		visible: ['b/x', 'c/x'],
		hidden: ['b/x', 'c/x'],
	},
	's*c/**/t*.ts': {
		visible: ['src/a/three.ts', 'src/deep/three.ts'],
		hidden: ['src/a/three.ts', 'src/deep/three.ts'],
	},
	'src/**/th**.ts': {
		visible: ['src/a/three.ts', 'src/deep/three.ts'],
		hidden: ['src/a/three.ts', 'src/deep/three.ts'],
	},
	'!(src)/x': {
		visible: ['aa/x', 'ab/x', 'b/x', 'c/x'],
		hidden: ['aa/x', 'ab/x', 'b/x', 'c/x'],
	},
	'!(a|b)': {
		visible: ['a b.md', 'file[1].txt', 'top.ts', 'x'],
		hidden: ['.env', '.secret.ts', 'a b.md', 'file[1].txt', 'top.ts', 'x'],
	},
	'src/+([a-z]).ts': {
		visible: ['src/one.ts'],
		hidden: ['src/one.ts'],
	},
	'a b.md': {
		visible: ['a b.md'],
		hidden: ['a b.md'],
	},
	'*[1].txt': {
		visible: [],
		hidden: [],
	},
	'file\\[*\\].txt': {
		visible: ['file[1].txt'],
		hidden: ['file[1].txt'],
	},
	'\\.env': {
		visible: ['.env'],
		hidden: ['.env'],
	},
	'*/*/x': {
		visible: ['a/b/x'],
		hidden: ['a/b/x'],
	},
	'*/.secret.ts': {
		visible: ['src/.secret.ts'],
		hidden: ['.config/.secret.ts', 'src/.secret.ts'],
	},
}

describe('file walk glob semantics', () => {
	for (const pattern of patterns) {
		it(pattern, async () => {
			for (const [key, includeHidden] of [
				['visible', false],
				['hidden', true],
			] as const) {
				const found: string[] = []
				for await (const entry of walkFilesLocally(root, {
					pattern,
					includeHidden,
					maxEntries: 1000,
				}))
					found.push(entry.path.slice(root.length + 1))
				expect(found.sort(), `${pattern} includeHidden=${includeHidden}`).toEqual(
					expected[pattern]?.[key],
				)
			}
		})
	}
})
