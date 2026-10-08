import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { bundledCliEntry } from './bundled-runtime.js'

describe('bundled CLI runtime', () => {
	const resourcesPath = join('install', 'resources')
	const entry = join(resourcesPath, 'cli', 'dist', 'bin.js')
	it('points an installed app at the CLI inside its own resources', () => {
		expect(bundledCliEntry({ isPackaged: true, resourcesPath, isFile: (p) => p === entry })).toBe(
			entry,
		)
	})
	it('never looks in resources for a development app', () => {
		expect(
			bundledCliEntry({ isPackaged: false, resourcesPath, isFile: () => true }),
		).toBeUndefined()
	})
	it('falls back when the CLI is not shipped or there is no resources path', () => {
		expect(
			bundledCliEntry({ isPackaged: true, resourcesPath, isFile: () => false }),
		).toBeUndefined()
		expect(
			bundledCliEntry({ isPackaged: true, resourcesPath: undefined, isFile: () => true }),
		).toBeUndefined()
	})
})
