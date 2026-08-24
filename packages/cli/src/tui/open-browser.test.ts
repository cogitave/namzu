import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
const accessSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
	accessSync,
}))

import { openInBrowser } from './open-browser.js'

function child() {
	return { on: vi.fn(), unref: vi.fn() }
}

describe('openInBrowser', () => {
	beforeEach(() => {
		spawn.mockReset()
		accessSync.mockReset()
		accessSync.mockReturnValue(undefined)
	})

	it('refuses anything that is not a web address', () => {
		spawn.mockReturnValue(child())
		for (const bad of [
			'file:///etc/passwd',
			'javascript:alert(1)',
			'ftp://example.invalid',
			'/usr/bin/thing',
			'',
		]) {
			expect(openInBrowser(bad)).toBe(false)
		}
		expect(spawn).not.toHaveBeenCalled()
	})

	it('never routes the address through a shell', () => {
		spawn.mockReturnValue(child())
		// The metacharacters that make `cmd /c start <url>` a command line.
		openInBrowser('https://example.invalid/?a=1&b=2^c|d')
		expect(spawn).toHaveBeenCalledTimes(1)
		const [command, args, options] = spawn.mock.calls[0] as [string, string[], object]
		expect(options).not.toHaveProperty('shell', true)
		expect(command).not.toMatch(/cmd(\.exe)?$/i)
		expect(command).not.toMatch(/(^|[\\/])sh$|bash|powershell/i)
		// The address is one argument, unsplit and unquoted.
		expect(args).toContain('https://example.invalid/?a=1&b=2^c|d')
		expect(command).toMatch(/^\//)
	})

	it('reports no browser when the host has no launcher', () => {
		accessSync.mockImplementation(() => {
			throw new Error('ENOENT')
		})

		expect(openInBrowser('https://example.invalid/')).toBe(false)
		expect(spawn).not.toHaveBeenCalled()
	})

	it('reports failure rather than throwing when no launcher can start', () => {
		spawn.mockImplementation(() => {
			throw new Error('ENOENT')
		})
		expect(openInBrowser('https://example.invalid/')).toBe(false)
	})

	it('survives a launcher that fails asynchronously, which is the headless case', () => {
		const c = child()
		spawn.mockReturnValue(c)
		expect(openInBrowser('https://example.invalid/')).toBe(true)
		// An `error` handler must be attached, or a missing `xdg-open` in a
		// container becomes an unhandled event and takes the process down.
		expect(c.on).toHaveBeenCalledWith('error', expect.any(Function))
		const handler = c.on.mock.calls.find((call) => call[0] === 'error')?.[1] as () => void
		expect(() => handler()).not.toThrow()
		// And it must be detached, or namzu waits on a browser to exit.
		expect(c.unref).toHaveBeenCalled()
	})
})
