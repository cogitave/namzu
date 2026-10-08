import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const { stripNodePty } = createRequire(import.meta.url)(
	'../../scripts/installer-after-pack.cjs',
) as {
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
