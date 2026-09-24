/**
 * A scheduled run's `PATH` leaves out the Windows drives, wherever WSL mounts
 * them: under WSL a failed lookup through a drive costs seconds, so the
 * entries under the mount root `/etc/wsl.conf` sets are dropped, and nothing
 * else is.
 */

import { describe, expect, it } from 'vitest'

import { childEnvironment, stripWindowsMounts } from '../env.js'

const path = [
	'/usr/local/bin',
	'/mnt/c/Windows/System32',
	'/mnt/d',
	'/win/c/Windows',
	'/win/C/Program Files/Git/cmd',
	'/usr/bin',
	'/mnt/wslg/runtime',
	'/winnie/bin',
].join(':')

describe("a scheduled run's PATH", () => {
	it('drops the drives under the default mount root and keeps the rest', () => {
		expect(stripWindowsMounts(path, '/mnt/')).toBe(
			'/usr/local/bin:/win/c/Windows:/win/C/Program Files/Git/cmd:/usr/bin:/mnt/wslg/runtime:/winnie/bin',
		)
	})

	it('drops the drives under a mount root wsl.conf moved, and only those', () => {
		expect(stripWindowsMounts(path, '/win/')).toBe(
			'/usr/local/bin:/mnt/c/Windows/System32:/mnt/d:/usr/bin:/mnt/wslg/runtime:/winnie/bin',
		)
	})

	it('treats a root with regular-expression characters literally', () => {
		expect(stripWindowsMounts('/a.b/c/x:/axb/c/x:/usr/bin', '/a.b/')).toBe('/axb/c/x:/usr/bin')
	})

	it('gives a fire child the stripped PATH under the root it is handed', () => {
		const env = childEnvironment({ PATH: path, HOME: '/home/u' }, '/tmp/namzu-home', '/win/')
		if (process.platform === 'win32') return
		expect(env.PATH).toBe(stripWindowsMounts(path, '/win/'))
		expect(env.PATH).not.toContain('/win/c')
		expect(env.NAMZU_HOME).toBe('/tmp/namzu-home')
	})
})
