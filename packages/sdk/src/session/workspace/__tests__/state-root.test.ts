import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultStateRoot } from '../state-root.js'

/**
 * Where generated state goes when a host names no place: a per-user state
 * directory, never the working directory and never the CLI's `~/.namzu`.
 */
describe('defaultStateRoot', () => {
	const home = '/home/someone'

	it('prefers NAMZU_STATE_DIR, resolved', () => {
		expect(defaultStateRoot({ NAMZU_STATE_DIR: '/srv/state' }, 'linux', home)).toBe('/srv/state')
		expect(defaultStateRoot({ NAMZU_STATE_DIR: 'rel' }, 'linux', home)).toBe(resolve('rel'))
	})

	it('follows XDG_STATE_HOME on Linux, and ignores a relative one as the spec says', () => {
		expect(defaultStateRoot({ XDG_STATE_HOME: '/x/state' }, 'linux', home)).toBe('/x/state/namzu')
		expect(defaultStateRoot({ XDG_STATE_HOME: 'x' }, 'linux', home)).toBe(
			join(home, '.local', 'state', 'namzu'),
		)
		expect(defaultStateRoot({}, 'linux', home)).toBe(join(home, '.local', 'state', 'namzu'))
	})

	it('uses the platform locations on macOS and Windows', () => {
		expect(defaultStateRoot({}, 'darwin', home)).toBe(
			join(home, 'Library', 'Application Support', 'namzu', 'state'),
		)
		expect(defaultStateRoot({ LOCALAPPDATA: '/c/Users/s/AppData/Local' }, 'win32', home)).toBe(
			join('/c/Users/s/AppData/Local', 'namzu', 'state'),
		)
	})

	it('is never the CLI home or the working directory', () => {
		for (const platform of ['linux', 'darwin', 'win32'] as const) {
			const root = defaultStateRoot({}, platform, home)
			expect(root).not.toBe(join(home, '.namzu'))
			expect(root.startsWith(join(home, '.namzu'))).toBe(false)
			expect(root.startsWith(process.cwd())).toBe(false)
		}
	})
})
