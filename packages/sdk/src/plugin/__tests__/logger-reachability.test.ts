import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'
import { configureLogger, discoverAllPluginDirs, discoverPlugins } from '../../index.js'

/**
 * Same defect as `skills/__tests__/logger-reachability.test.ts`, in the
 * plugin loader: `discoverPlugins` and `discoverAllPluginDirs` each used to
 * resolve their own logger at module scope (`plugin/loader.ts:12`), frozen
 * by `child()` at whatever level was live when the module first loaded —
 * under this package's `test-setup.ts`, always 'silent', before any test's
 * own `configureLogger()` call could run. See that file's docblock for the
 * full reasoning; not repeated here. These are the plugin file's only two
 * logging call sites, so both are covered.
 */
describe('plugin loader logger reachability', () => {
	let stderr: string
	let originalStderrWrite: typeof process.stderr.write
	let root: string

	beforeEach(async () => {
		stderr = ''
		originalStderrWrite = process.stderr.write.bind(process.stderr)
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stderr.write
		root = await mkdtemp(join(tmpdir(), 'namzu-plugin-logger-'))
	})

	afterEach(async () => {
		process.stderr.write = originalStderrWrite
		configureLogger({ level: 'silent' })
		await removeTempDirAsync(root)
	})

	it('discoverPlugins against a missing directory is reachable by a later configureLogger', async () => {
		const missing = join(root, 'does-not-exist')

		configureLogger({ level: 'debug' })
		await discoverPlugins(missing)
		expect(stderr).toContain('Plugins directory not found')

		stderr = ''
		configureLogger({ level: 'silent' })
		await discoverPlugins(missing)
		expect(stderr).not.toContain('Plugins directory not found')
	})

	it('discoverAllPluginDirs is reachable by a later configureLogger', async () => {
		configureLogger({ level: 'debug' })
		await discoverAllPluginDirs(root, { enabled: false })
		expect(stderr).toContain('Plugin discovery skipped')

		stderr = ''
		configureLogger({ level: 'silent' })
		await discoverAllPluginDirs(root, { enabled: false })
		expect(stderr).not.toContain('Plugin discovery skipped')
	})
})
