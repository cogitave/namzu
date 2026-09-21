import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { NamzuHomeError, resolveNamzuHome } from '../home.js'

// Copied from the CLI's own suite (packages/cli/src/integrations/state/home.test.ts)
// when the resolver moved into the SDK: every case it held still holds here.
describe('Namzu application home', () => {
	it('defaults to one hidden directory below the OS home without creating it', async () => {
		const home = await mkdtemp(join(tmpdir(), 'namzu-home-default-'))
		expect(resolveNamzuHome({ home, env: {} })).toBe(join(home, '.namzu'))
	})

	it('canonicalizes an existing explicit NAMZU_HOME', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'namzu-home-explicit-'))
		const state = join(parent, 'state')
		mkdirSync(state)
		expect(resolveNamzuHome({ env: { NAMZU_HOME: state } })).toBe(resolve(state))
	})

	it.each([
		['missing', (root: string) => join(root, 'missing')],
		[
			'file',
			(root: string) => {
				const path = join(root, 'file')
				writeFileSync(path, 'x')
				return path
			},
		],
		[
			'symlink',
			(root: string) => {
				const target = join(root, 'target')
				const path = join(root, 'link')
				mkdirSync(target)
				symlinkSync(target, path, 'dir')
				return path
			},
		],
	] as const)('refuses an explicit %s path', async (_name, makePath) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-home-refusal-'))
		expect(() => resolveNamzuHome({ env: { NAMZU_HOME: makePath(root) } })).toThrow(NamzuHomeError)
	})

	it('treats an empty override as absent', async () => {
		const home = await mkdtemp(join(tmpdir(), 'namzu-home-empty-'))
		expect(resolveNamzuHome({ home, env: { NAMZU_HOME: '' } })).toBe(join(home, '.namzu'))
	})

	it('refuses a NUL byte and a filesystem root', async () => {
		expect(() => resolveNamzuHome({ env: { NAMZU_HOME: 'a\0b' } })).toThrow(/NUL/)
		expect(() => resolveNamzuHome({ env: { NAMZU_HOME: '/' } })).toThrow(/filesystem root/)
	})
})

describe('the SDK test run', () => {
	it("resolves the default home inside the runner's owned root, never the user's", () => {
		const ownedRoot = process.env.NAMZU_SDK_TEST_ROOT
		expect(ownedRoot, 'scripts/run-sdk-tests.mjs sets the owned root').toBeTruthy()
		const home = resolveNamzuHome()
		const inside = relative(realpathSync(ownedRoot as string), home)
		expect(inside.length > 0 && !inside.startsWith('..'), home).toBe(true)
	})
})
