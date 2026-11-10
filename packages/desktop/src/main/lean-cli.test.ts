import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type Target = { platform: string; arch: string }
type Lean = {
	parseTarget: (text: string) => Target
	loadExternals: (cliPackageDir: string) => Promise<string[]>
	packageNameOf: (specifier: string) => string
	isPackageSpecifier: (specifier: string) => boolean
	appliesToTarget: (manifest: Record<string, unknown>, target: Target) => boolean
	isForeignPrebuild: (name: string, target: Target) => boolean
	deriveKeepSet: (input: { externals: string[]; root: string; target: Target }) => {
		keep: Map<string, string>
		skippedForTarget: string[]
	}
	pruneToKeepSet: (
		root: string,
		keep: Map<string, string>,
	) => { removed: string[]; licences: unknown[] }
	pruneForeignPrebuilds: (root: string, target: Target) => number
	leanCli: (input: { root: string; externals: string[]; target: Target }) => {
		keep: Map<string, string>
		removedPackages: number
	}
}
type Check = {
	scanSpecifiers: (distDir: string) => Map<string, string>
	checkStagedCli: (input: {
		cliDir: string
		externals: string[]
		target: Target
	}) => Promise<{ failures: string[]; report: { notImported: string[] } }>
}
const lean = (await import(
	/* @vite-ignore */ new URL('../../scripts/lean-cli.mjs', import.meta.url).href
)) as Lean
const check = (await import(
	/* @vite-ignore */ new URL('../../scripts/check-staged-cli.mjs', import.meta.url).href
)) as Check

const WIN: Target = { platform: 'win32', arch: 'x64' }
const LINUX: Target = { platform: 'linux', arch: 'x64' }
const HOST: Target = { platform: process.platform, arch: process.arch }

const folders: string[] = []
function scratch(): string {
	const folder = mkdtempSync(join(tmpdir(), 'namzu-lean-test-'))
	folders.push(folder)
	return folder
}
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function write(path: string, text: string): void {
	mkdirSync(join(path, '..'), { recursive: true })
	writeFileSync(path, text)
}
/** A package in a fake deployed tree. */
function pkg(
	root: string,
	name: string,
	manifest: Record<string, unknown> = {},
	files: Record<string, string> = {},
) {
	const dir = join(root, 'node_modules', name)
	write(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...manifest }))
	write(join(dir, 'index.js'), 'export default 1\n')
	write(join(dir, 'LICENSE'), `Licence of ${name}\n`)
	for (const [file, text] of Object.entries(files)) write(join(dir, file), text)
	return dir
}
function cliRoot(manifest: Record<string, unknown>): string {
	const root = scratch()
	write(
		join(root, 'package.json'),
		JSON.stringify({ name: '@namzu/cli', version: '9.9.9', ...manifest }),
	)
	return root
}

describe('the keep-set', () => {
	const externals = ['alpha', '@scope/beta', 'native']

	function tree() {
		const root = cliRoot({
			dependencies: { alpha: '1', '@scope/beta': '1', native: '1', bundled: '1' },
			optionalDependencies: {},
		})
		pkg(root, 'alpha', {
			dependencies: { gamma: '1' },
			optionalDependencies: { 'alpha-extra': '1', 'alpha-absent': '1' },
		})
		pkg(root, 'gamma', { peerDependencies: { delta: '1', 'peer-absent': '1' } })
		pkg(root, 'delta')
		pkg(root, 'alpha-extra')
		pkg(root, '@scope/beta')
		pkg(root, 'native', {
			optionalDependencies: { 'native-win32-x64': '1', 'native-linux-x64': '1' },
		})
		pkg(root, 'native-win32-x64', { os: ['win32'], cpu: ['x64'] })
		pkg(root, 'native-linux-x64', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] })
		pkg(root, 'bundled', { dependencies: { 'only-bundled': '1' } })
		pkg(root, 'only-bundled')
		return root
	}
	const names = (root: string, keep: Map<string, string>) =>
		[...keep.keys()].map((dir) => dir.slice(join(root, 'node_modules').length + 1)).sort()

	it('is the externals and the closure of their dependencies, optional ones and peers', () => {
		const root = tree()
		const { keep } = lean.deriveKeepSet({ externals, root, target: WIN })
		expect(names(root, keep)).toEqual(
			[
				'@scope/beta',
				'alpha',
				'alpha-extra',
				'delta',
				'gamma',
				'native',
				'native-win32-x64',
			].sort(),
		)
		expect(keep.get(join(root, 'node_modules/alpha'))).toBe('external of the bundle')
		expect(keep.get(join(root, 'node_modules/gamma'))).toBe('needed by alpha')
		expect(keep.get(join(root, 'node_modules/delta'))).toBe('peer of gamma')
	})

	it('leaves out what the bundle inlined, and the platform packages of other targets', () => {
		const root = tree()
		const win = lean.deriveKeepSet({ externals, root, target: WIN })
		expect(names(root, win.keep)).not.toContain('bundled')
		expect(names(root, win.keep)).not.toContain('only-bundled')
		expect(win.skippedForTarget).toEqual(['native-linux-x64'])
		const linux = lean.deriveKeepSet({ externals, root, target: LINUX })
		expect(names(root, linux.keep)).toContain('native-linux-x64')
		expect(names(root, linux.keep)).not.toContain('native-win32-x64')
	})

	it('stops when an external the CLI depends on is not in the deployed tree', () => {
		const root = tree()
		rmSync(join(root, 'node_modules/@scope/beta'), { recursive: true })
		expect(() => lean.deriveKeepSet({ externals, root, target: WIN })).toThrow(
			/"@scope\/beta".*no such package/,
		)
	})

	it('stops when an external is neither declared nor on the list of those meant to be absent', () => {
		const root = tree()
		expect(() =>
			lean.deriveKeepSet({ externals: [...externals, 'surprise'], root, target: WIN }),
		).toThrow(/"surprise".*does not declare it/)
		const { keep } = lean.deriveKeepSet({
			externals: [...externals, 'react-devtools-core'],
			root,
			target: WIN,
		})
		expect(keep.size).toBeGreaterThan(0)
	})

	it('stops when a kept package needs a dependency that is not there', () => {
		const root = tree()
		rmSync(join(root, 'node_modules/gamma'), { recursive: true })
		pkg(root, 'gamma', { dependencies: { vanished: '1' } })
		expect(() => lean.deriveKeepSet({ externals, root, target: WIN })).toThrow(/"vanished"/)
	})

	it('resolves a nested copy before the hoisted one', () => {
		const root = tree()
		pkg(root, 'alpha/node_modules/gamma', { version: '2.0.0' })
		const { keep } = lean.deriveKeepSet({ externals, root, target: WIN })
		expect(keep.has(join(root, 'node_modules/alpha/node_modules/gamma'))).toBe(true)
		expect(keep.has(join(root, 'node_modules/gamma'))).toBe(false)
	})

	it('removes the rest and writes the licences of what it removed into one file', () => {
		const root = tree()
		const result = lean.leanCli({ root, externals, target: WIN })
		expect(result.removedPackages).toBe(3) // bundled, only-bundled, native-linux-x64
		expect(existsSync(join(root, 'node_modules/bundled'))).toBe(false)
		expect(existsSync(join(root, 'node_modules/alpha/index.js'))).toBe(true)
		const licences = readFileSync(join(root, 'THIRD-PARTY-LICENSES.txt'), 'utf8')
		expect(licences).toContain('bundled@1.0.0')
		expect(licences).toContain('Licence of only-bundled')
		// a kept package keeps its own licence file where it is
		expect(existsSync(join(root, 'node_modules/alpha/LICENSE'))).toBe(true)
	})

	it('reads the externals from the CLI package the bundle reads, not from a copy', async () => {
		const cli = join(import.meta.dirname, '../../../cli')
		const list = await lean.loadExternals(cli)
		expect(list).toContain('node-pty')
		const bundle = readFileSync(join(cli, 'scripts/bundle.mjs'), 'utf8')
		expect(bundle).toContain("from './externals.mjs'")
		expect(bundle).not.toMatch(/const external = \[/)
	})
})

describe('native binaries by target', () => {
	it('parses the target and refuses nonsense', () => {
		expect(lean.parseTarget('win32-x64')).toEqual(WIN)
		expect(() => lean.parseTarget('windows')).toThrow(/--target/)
	})

	it('judges a platform package by the os, cpu and libc fields of its manifest', () => {
		expect(lean.appliesToTarget({}, WIN)).toBe(true)
		expect(lean.appliesToTarget({ os: ['win32'], cpu: ['x64'] }, WIN)).toBe(true)
		expect(lean.appliesToTarget({ os: ['linux'], cpu: ['x64'] }, WIN)).toBe(false)
		expect(lean.appliesToTarget({ os: ['win32'], cpu: ['arm64'] }, WIN)).toBe(false)
		expect(lean.appliesToTarget({ os: ['linux'], cpu: ['x64'], libc: ['musl'] }, LINUX)).toBe(true)
		expect(lean.appliesToTarget({ os: ['!win32'] }, WIN)).toBe(false)
		expect(lean.appliesToTarget({ libc: ['glibc'] }, WIN)).toBe(false)
	})

	it('names the prebuild folders of other platforms, and only those', () => {
		for (const name of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-arm64', 'linuxmusl-x64'])
			expect(lean.isForeignPrebuild(name, WIN)).toBe(true)
		expect(lean.isForeignPrebuild('win32-x64', WIN)).toBe(false)
		expect(lean.isForeignPrebuild('linux-x64', LINUX)).toBe(false)
		expect(lean.isForeignPrebuild('universal', WIN)).toBe(false)
	})

	it('keeps only the target folder under prebuilds, whatever machine runs it', () => {
		const root = scratch()
		for (const platform of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'linux-x64'])
			write(join(root, 'node_modules/node-pty/prebuilds', platform, 'pty.node'), 'x')
		write(join(root, 'node_modules/node-pty/lib/index.js'), 'x')
		expect(lean.pruneForeignPrebuilds(root, WIN)).toBe(3)
		expect(existsSync(join(root, 'node_modules/node-pty/prebuilds/win32-x64/pty.node'))).toBe(true)
		expect(existsSync(join(root, 'node_modules/node-pty/prebuilds/darwin-arm64'))).toBe(false)
		expect(existsSync(join(root, 'node_modules/node-pty/lib/index.js'))).toBe(true)
	})
})

describe('the staged-tree check', () => {
	/** A staged CLI that answers --version and initialize, and whose chunk imports two packages. */
	function staged(): string {
		const root = cliRoot({})
		write(
			join(root, 'dist/bin.js'),
			`import { createInterface } from 'node:readline'
if (process.argv.includes('--version')) { console.log('9.9.9'); process.exit(0) }
await import('./chunks/chunk-A.js')
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
	const message = JSON.parse(line)
	process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\\n')
}
`,
		)
		write(
			join(root, 'dist/chunks/chunk-A.js'),
			`import fakedep from 'fakedep'
const text = "import x from 'in-a-string'"
export { fakedep, text }
export const lazy = () => import('fakeext/sub.js')
`,
		)
		pkg(root, 'fakedep')
		pkg(root, 'fakeext', {}, { 'sub.js': 'export default 2\n' })
		return root
	}

	it('reads the specifiers a chunk imports, and not the ones its strings mention', () => {
		const root = staged()
		expect([...check.scanSpecifiers(join(root, 'dist')).keys()].sort()).toEqual([
			'fakedep',
			'fakeext/sub.js',
		])
	})

	it('passes a tree that carries everything, importing what loads on this machine', async () => {
		const root = staged()
		const { failures } = await check.checkStagedCli({
			cliDir: root,
			externals: ['fakeext'],
			target: HOST,
		})
		expect(failures).toEqual([])
	})

	it('does not import a package that only loads on another target, it asks for its files', async () => {
		const root = staged()
		pkg(root, 'fakeext', { optionalDependencies: { 'fakeext-win32-x64': '1' } })
		const { failures, report } = await check.checkStagedCli({
			cliDir: root,
			externals: ['fakeext'],
			target: { platform: process.platform === 'win32' ? 'linux' : 'win32', arch: 'x64' },
		})
		expect(report.notImported).toContain('fakeext/sub.js')
		expect(failures).toEqual([])
	})

	it('fails, naming the package, when one the bundle needs has been removed', async () => {
		const root = staged()
		rmSync(join(root, 'node_modules/fakedep'), { recursive: true })
		const { failures } = await check.checkStagedCli({
			cliDir: root,
			externals: ['fakeext'],
			target: HOST,
		})
		expect(failures.join('\n')).toMatch(/fakedep/)
		expect(failures.join('\n')).toMatch(/acp --desktop/)
	})

	it('fails when a declared external is missing from the tree', async () => {
		const root = staged()
		rmSync(join(root, 'node_modules/fakeext'), { recursive: true })
		const { failures } = await check.checkStagedCli({
			cliDir: root,
			externals: ['fakeext'],
			target: HOST,
		})
		expect(failures.join('\n')).toMatch(/fakeext/)
	})
})
