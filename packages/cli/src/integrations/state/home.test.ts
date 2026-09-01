import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { NamzuHomeError, namzuHomePath, resolveNamzuHome } from './home.js'

describe('Namzu application home', () => {
	it('defaults to one hidden directory below the OS home without creating it', async () => {
		const home = await mkdtemp(join(tmpdir(), 'namzu-home-default-'))
		expect(resolveNamzuHome({ home, env: {} })).toBe(join(home, '.namzu'))
		expect(namzuHomePath(home)).toBe(join(home, '.namzu'))
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
})
