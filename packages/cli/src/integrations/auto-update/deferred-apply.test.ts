import type { ChildProcess, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { APPLY_AT_EXIT_FLAG, launchApplyAtExit } from './deferred-apply.js'

describe('handing an update over to the process that outlives the session', () => {
	it('starts the installer detached, with no terminal, naming the flag and the entry', () => {
		const child = { on: vi.fn(), unref: vi.fn() } as unknown as ChildProcess
		const fake = vi.fn(() => child) as unknown as typeof spawn
		expect(launchApplyAtExit(fake, '/opt/cli/dist/bin.js')).toBe(true)
		const [command, args, options] = (fake as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, string[], { detached: boolean; stdio: string; env: NodeJS.ProcessEnv }]
		expect(command).toBe(process.execPath)
		expect(args).toEqual(['/opt/cli/dist/bin.js', APPLY_AT_EXIT_FLAG])
		expect(options.detached).toBe(true)
		expect(options.stdio).toBe('ignore')
		expect(options.env.NAMZU_AUTO_UPDATE).toBe('1')
		expect(child.unref).toHaveBeenCalled()
	})

	it('never throws when the process cannot be started: the next session that ends tries again', () => {
		const fake = vi.fn(() => {
			throw new Error('EAGAIN')
		}) as unknown as typeof spawn
		expect(launchApplyAtExit(fake, '/x/bin.js')).toBe(false)
	})
})
