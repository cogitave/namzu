import { describe, expect, it } from 'vitest'

import { classifyInstall, pnpmGlobalDirFor } from './install-kind.js'

const never = () => false
const always = () => true

const classify = (
	packageRoot: string,
	extra: Partial<Parameters<typeof classifyInstall>[0]> = {},
) =>
	classifyInstall({
		packageRoot,
		platform: 'linux',
		exists: never,
		writable: always,
		...extra,
	})

describe('install classification', () => {
	it('recognises an npm global installation and whether its folders are writable', () => {
		expect(classify('/home/a/.nvm/versions/node/v22/lib/node_modules/@namzu/cli')).toMatchObject({
			kind: 'npm-global',
			prefix: '/home/a/.nvm/versions/node/v22',
			owned: false,
			writable: true,
		})
		expect(classify('/usr/lib/node_modules/@namzu/cli', { writable: never })).toMatchObject({
			kind: 'npm-global',
			prefix: '/usr',
			writable: false,
		})
	})

	it('knows the installer fallback prefix inside the Namzu home is Namzu-owned', () => {
		expect(
			classify('/home/a/.namzu/lib/node_modules/@namzu/cli', { namzuHome: '/home/a/.namzu' }),
		).toMatchObject({ kind: 'npm-global', owned: true })
	})

	it('needs the scope folder and the prefix writable, not just one of them', () => {
		const seen: string[] = []
		classify('/opt/n/lib/node_modules/@namzu/cli', {
			writable: (path) => {
				seen.push(path)
				return true
			},
		})
		expect(seen).toEqual(['/opt/n/lib/node_modules/@namzu', '/opt/n'])
	})

	it('recognises a pnpm global installation by the store path it really runs from', () => {
		const root =
			'/home/a/.local/share/pnpm/global/5/.pnpm/@namzu+cli@41.0.0/node_modules/@namzu/cli'
		expect(classify(root)).toMatchObject({
			kind: 'pnpm-global',
			globalDir: '/home/a/.local/share/pnpm/global/5',
			writable: true,
		})
		expect(pnpmGlobalDirFor(root)).toBe('/home/a/.local/share/pnpm/global/5')
		expect(pnpmGlobalDirFor('/usr/lib/node_modules/@namzu/cli')).toBeNull()
	})

	it('leaves a pnpm global installation on Windows to the person, who is given the command', () => {
		const root =
			'C:\\Users\\A\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\@namzu+cli@41.0.0\\node_modules\\@namzu\\cli'
		expect(classify(root, { platform: 'win32' })).toMatchObject({
			kind: 'pnpm-global',
			writable: false,
		})
	})

	it('never treats a source checkout as updatable', () => {
		expect(
			classify('/work/namzu/packages/cli', { exists: (p) => p.endsWith('pnpm-workspace.yaml') }),
		).toEqual({ kind: 'development', root: '/work/namzu/packages/cli' })
		expect(
			classify('/work/namzu/packages/cli', { exists: (p) => p.endsWith('/src') }),
		).toMatchObject({ kind: 'development' })
	})

	it('never treats npx, dlx or the Desktop copy as updatable', () => {
		expect(classify('/home/a/.npm/_npx/abc123/node_modules/@namzu/cli')).toMatchObject({
			kind: 'ephemeral',
		})
		expect(classify('/home/a/.cache/pnpm/dlx-9f/node_modules/@namzu/cli')).toMatchObject({
			kind: 'ephemeral',
		})
		expect(
			classify('C:\\Users\\A\\AppData\\Local\\Programs\\Namzu\\resources\\cli', {
				platform: 'win32',
			}),
		).toMatchObject({ kind: 'desktop' })
		expect(
			classify('/opt/anything/lib/node_modules/@namzu/cli', { isElectron: true }),
		).toMatchObject({
			kind: 'desktop',
		})
	})

	it('calls any other layout unknown instead of guessing', () => {
		expect(classify('/srv/vendored/namzu')).toEqual({
			kind: 'unknown',
			root: '/srv/vendored/namzu',
		})
	})
})
