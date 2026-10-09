import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { bakedFeedDeclared } from './updater.js'

const { stripNodePty, writeAppUpdateYml } = createRequire(import.meta.url)(
	'../../scripts/installer-after-pack.cjs',
) as {
	writeAppUpdateYml(file: string): void
	stripNodePty(dir: string, target: { platform: string; arch: string }): boolean
}
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-after-pack-'))
	roots.push(dir)
	const files = [
		'package.json',
		'lib/index.js',
		'typings/node-pty.d.ts',
		'prebuilds/win32-x64/pty.node',
		'prebuilds/win32-x64/pty.pdb',
		'prebuilds/win32-x64/conpty.node',
		'prebuilds/win32-x64/winpty-agent.exe',
		'prebuilds/win32-x64/conpty/OpenConsole.exe',
		'prebuilds/win32-x64/conpty/OpenConsole.pdb',
		'prebuilds/win32-arm64/pty.node',
		'prebuilds/darwin-arm64/pty.node',
		'build/Release/pty.node',
		'src/win/conpty.cc',
		'deps/winpty/x.cc',
		'third_party/conpty/x.dll',
		'scripts/prebuild.js',
		'binding.gyp',
		'node-addon-api@7.1.1/napi.h',
	]
	for (const file of files) {
		mkdirSync(join(dir, file, '..'), { recursive: true })
		writeFileSync(join(dir, file), '')
	}
	return dir
}
const tree = (dir: string, prefix = ''): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? tree(join(dir, entry.name), `${prefix}${entry.name}/`)
			: [`${prefix}${entry.name}`],
	)

it('keeps the target platform binaries and what loads them, and nothing else', () => {
	const dir = fixture()
	expect(stripNodePty(dir, { platform: 'win32', arch: 'x64' })).toBe(true)
	expect(tree(dir).sort()).toEqual([
		'lib/index.js',
		'package.json',
		'prebuilds/win32-x64/conpty.node',
		'prebuilds/win32-x64/conpty/OpenConsole.exe',
		'prebuilds/win32-x64/pty.node',
		'prebuilds/win32-x64/winpty-agent.exe',
		'typings/node-pty.d.ts',
	])
})

it('fails loudly when the package has no binary for the platform', () => {
	const dir = fixture()
	expect(() => stripNodePty(dir, { platform: 'win32', arch: 'ia32' })).toThrow(/win32-ia32/)
})

it('reports a runtime without the package', () => {
	expect(
		stripNodePty(join(tmpdir(), 'namzu-no-such-node-pty'), { platform: 'win32', arch: 'x64' }),
	).toBe(false)
})

function ymlPath() {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-app-update-'))
	roots.push(dir)
	return join(dir, 'app-update.yml')
}
const BUILT = [
	'provider: generic',
	'url: https://github.com/cogitave/namzu/releases/download/desktop-latest/',
	'useMultipleRangeRequest: false',
]

it('keeps the feed electron-builder wrote and sets the cache folder name once', () => {
	const file = ymlPath()
	writeFileSync(file, `${[...BUILT, 'updaterCacheDirName: namzu-desktop-updater'].join('\n')}\n`)
	writeAppUpdateYml(file)
	expect(readFileSync(file, 'utf8')).toBe(
		`${[...BUILT, 'updaterCacheDirName: namzu-updater'].join('\n')}\n`,
	)
})

it('appends the cache folder name when the file has none', () => {
	const file = ymlPath()
	writeFileSync(file, `${BUILT.join('\n')}\n`)
	writeAppUpdateYml(file)
	expect(readFileSync(file, 'utf8')).toBe(
		`${[...BUILT, 'updaterCacheDirName: namzu-updater'].join('\n')}\n`,
	)
})

it('writes a cache-only file when electron-builder wrote none', () => {
	const file = ymlPath()
	writeAppUpdateYml(file)
	expect(readFileSync(file, 'utf8')).toBe('updaterCacheDirName: namzu-updater\n')
	expect(bakedFeedDeclared(readFileSync(file, 'utf8'))).toBe(false)
})

it('keeps the publish block of electron-builder.yml what bakedFeedDeclared reads as a feed', () => {
	const config = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
	const block = /^publish:\s*\n((?:[ \t]+.*\n?)+)/m.exec(config)?.[1] ?? ''
	expect(block).toMatch(/^\s+provider:\s*generic\s*$/m)
	expect(block).toMatch(
		/^\s+url:\s*https:\/\/github\.com\/cogitave\/namzu\/releases\/download\/desktop-latest\/\s*$/m,
	)
	const file = ymlPath()
	writeFileSync(file, `${BUILT.join('\n')}\n`)
	writeAppUpdateYml(file)
	expect(bakedFeedDeclared(readFileSync(file, 'utf8'))).toBe(true)
})
