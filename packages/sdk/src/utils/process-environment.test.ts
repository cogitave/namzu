import { describe, expect, it } from 'vitest'

import {
	WINDOWS_CORE_ENV_KEYS,
	applyEnvironmentOverrides,
	pickEnvironmentEntries,
	readEnvironmentEntry,
} from './process-environment.js'

describe('core process environment names', () => {
	it('reads Windows names case-insensitively and preserves the parent spelling', () => {
		const source = {
			Path: 'C:\\bin',
			WinDir: 'C:\\Windows',
			SYSTEMROOT: 'C:\\Windows',
			UNNAMED_SECRET: 'must-not-travel',
		}
		const env = pickEnvironmentEntries(['PATH', 'WINDIR', 'SystemRoot'], source, 'win32')

		expect(env).toEqual({
			Path: 'C:\\bin',
			WinDir: 'C:\\Windows',
			SYSTEMROOT: 'C:\\Windows',
		})
		expect(env).not.toHaveProperty('UNNAMED_SECRET')
	})

	it('prefers an exact Windows spelling when an injected object contains impossible twins', () => {
		const found = readEnvironmentEntry({ Path: 'ambient', PATH: 'explicit' }, 'PATH', 'win32')

		expect(found).toEqual(['PATH', 'explicit'])
	})

	it('makes each later Windows override the sole case-insensitive winner', () => {
		const env: Record<string, string> = { PATH: 'ambient', PathExt: '.EXE' }

		applyEnvironmentOverrides(env, { Path: 'config' }, 'win32')
		applyEnvironmentOverrides(env, { PATH: 'per-call' }, 'win32')

		expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['PATH'])
		expect(env.PATH).toBe('per-call')
		expect(env.Path).toBeUndefined()
	})

	it('keeps POSIX names case-sensitive', () => {
		const env = { PATH: '/ambient' }

		applyEnvironmentOverrides(env, { Path: '/different-name' }, 'linux')

		expect(env).toEqual({ PATH: '/ambient', Path: '/different-name' })
	})

	it('includes the Windows startup names this boundary depends on', () => {
		expect(WINDOWS_CORE_ENV_KEYS).toEqual(
			expect.arrayContaining(['PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR', 'TEMP', 'USERPROFILE']),
		)
	})
})
