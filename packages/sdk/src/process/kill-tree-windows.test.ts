import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	execFileSync,
}))

import { killTree, registerMsysShell } from './kill-tree.js'

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor

afterEach(() => {
	Object.defineProperty(process, 'platform', platform)
	execFileSync.mockReset()
})

function onWindows(): void {
	Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
}

describe('killTree on Windows', () => {
	it('walks the Windows tree with taskkill', () => {
		onWindows()
		const child = { pid: 4242 } as ReturnType<typeof spawn>
		killTree(child, 'SIGTERM')
		expect(execFileSync).toHaveBeenCalledTimes(1)
		expect(execFileSync.mock.calls[0]?.[1]).toEqual(['/pid', '4242', '/t', '/f'])
	})

	it('first ends what a Git Bash command forked, found by the tag in its environment', () => {
		onWindows()
		const child = { pid: 4242 } as ReturnType<typeof spawn>
		registerMsysShell(child, { bash: 'C:\\Git\\bin\\bash.exe', tag: 'tag-1' })
		killTree(child, 'SIGKILL')
		expect(execFileSync).toHaveBeenCalledTimes(2)
		const [file, args] = execFileSync.mock.calls[0] as [string, string[]]
		expect(file).toBe('C:\\Git\\bin\\bash.exe')
		expect(args[0]).toBe('-c')
		expect(args[1]).toContain('NAMZU_SHELL_TAG=tag-1')
		expect(args[1]).toContain('/proc/[0-9]*/environ')
		expect(execFileSync.mock.calls[1]?.[1]).toEqual(['/pid', '4242', '/t', '/f'])
	})

	it('still runs taskkill when the msys kill cannot start', () => {
		onWindows()
		const child = { pid: 7 } as ReturnType<typeof spawn>
		registerMsysShell(child, { bash: 'C:\\Git\\bin\\bash.exe', tag: 'tag-2' })
		execFileSync.mockImplementationOnce(() => {
			throw new Error('spawn failed')
		})
		killTree(child, 'SIGTERM')
		expect(execFileSync).toHaveBeenCalledTimes(2)
	})
})
