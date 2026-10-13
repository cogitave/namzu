import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { enableStartupCompileCache } from '../compile-cache.js'

let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-compile-cache-'))
})

afterEach(() => {
	removeTempDir(root)
})

const ENABLED = 1
const FAILED = 0
const ALREADY_ENABLED = 2

describe('the startup compile cache', () => {
	it('is enabled under the Namzu home when it exists', () => {
		const enableCompileCache = vi.fn(() => ({ status: ENABLED, directory: 'dir' }))

		const outcome = enableStartupCompileCache({
			env: { NAMZU_HOME: root },
			module: { enableCompileCache },
		})

		expect(enableCompileCache).toHaveBeenCalledWith(join(root, 'cache', 'compile'))
		expect(outcome).toEqual({ state: 'enabled', directory: 'dir' })
	})

	it('uses ~/.namzu when NAMZU_HOME is unset', () => {
		mkdirSync(join(root, '.namzu'))
		const enableCompileCache = vi.fn(() => ({ status: ENABLED, directory: 'dir' }))

		enableStartupCompileCache({ env: {}, home: root, module: { enableCompileCache } })

		expect(enableCompileCache).toHaveBeenCalledWith(join(root, '.namzu', 'cache', 'compile'))
	})

	it('does not create a Namzu home that is not there, or follow a link to one', () => {
		const enableCompileCache = vi.fn(() => ({ status: ENABLED, directory: 'dir' }))
		const missing = join(root, 'missing')
		const target = join(root, 'target')
		const link = join(root, 'link')
		mkdirSync(target)
		symlinkSync(target, link, 'dir')

		for (const env of [{ NAMZU_HOME: missing }, { NAMZU_HOME: link }, {}]) {
			const outcome = enableStartupCompileCache({
				env,
				home: join(root, 'no-home'),
				module: { enableCompileCache },
			})
			expect(outcome.state).toBe('skipped')
		}

		expect(enableCompileCache).not.toHaveBeenCalled()
		expect(existsSync(missing)).toBe(false)
		expect(existsSync(join(root, 'no-home'))).toBe(false)
	})

	it('leaves Node’s own switches in charge', () => {
		const enableCompileCache = vi.fn(() => ({ status: ENABLED, directory: 'dir' }))

		for (const env of [
			{ NAMZU_HOME: root, NODE_DISABLE_COMPILE_CACHE: '1' },
			{ NAMZU_HOME: root, NODE_COMPILE_CACHE: join(root, 'elsewhere') },
		]) {
			expect(enableStartupCompileCache({ env, module: { enableCompileCache } }).state).toBe(
				'skipped',
			)
		}

		expect(enableCompileCache).not.toHaveBeenCalled()
	})

	it('does nothing on a Node without the function', () => {
		const outcome = enableStartupCompileCache({ env: { NAMZU_HOME: root }, module: {} })

		expect(outcome.state).toBe('skipped')
	})

	it('reports a failure instead of throwing, whether Node returns it or raises it', () => {
		const returned = enableStartupCompileCache({
			env: { NAMZU_HOME: root },
			module: { enableCompileCache: () => ({ status: FAILED, message: 'read-only file system' }) },
		})
		const raised = enableStartupCompileCache({
			env: { NAMZU_HOME: root },
			module: {
				enableCompileCache: () => {
					throw new Error('EACCES')
				},
			},
		})
		const again = enableStartupCompileCache({
			env: { NAMZU_HOME: root },
			module: { enableCompileCache: () => ({ status: ALREADY_ENABLED }) },
		})

		expect(returned).toEqual({ state: 'failed', reason: 'read-only file system' })
		expect(raised).toEqual({ state: 'failed', reason: 'EACCES' })
		expect(again.state).toBe('skipped')
	})

	it('survives the real Node function refusing the directory', () => {
		// `cache` is a file, so Node cannot make `cache/compile`: the real
		// function answers with a failure status, and nothing is enabled.
		writeFileSync(join(root, 'cache'), 'not a directory')

		const outcome = enableStartupCompileCache({ env: { NAMZU_HOME: root } })

		expect(outcome.state).toBe('failed')
	})
})
