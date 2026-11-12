import { spawn } from 'node:child_process'
import { SESSION_CHILD_ENV } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
	ancestorsOf,
	defaultParentPid,
	processStartedBySession,
	runsUnderAny,
} from './process-ancestry.js'

/** A child that stays until its standard input closes, so its environment can be read without a clock. */
function waiting(env: NodeJS.ProcessEnv) {
	const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
		env,
		stdio: ['pipe', 'ignore', 'ignore'],
	})
	return { pid: child.pid as number, stop: () => child.stdin?.end() }
}

describe('process ancestry', () => {
	it('reads this process parent from the operating system', () => {
		if (process.platform === 'win32') return
		expect(defaultParentPid(process.pid)).toBe(process.ppid)
		expect(ancestorsOf(process.pid)[0]).toBe(process.ppid)
	})
	it('walks a chain nearest first, stops at a loop, and finds a session above', () => {
		const parents = new Map([
			[10, 20],
			[20, 30],
			[30, 20],
		])
		expect(ancestorsOf(10, (pid) => parents.get(pid))).toEqual([20, 30])
		expect(runsUnderAny(10, new Set([30]), (pid) => parents.get(pid))).toBe(true)
		expect(runsUnderAny(10, new Set([10]), (pid) => parents.get(pid))).toBe(false)
	})
})

describe("a process's starting environment", () => {
	it.runIf(process.platform === 'linux')(
		'tells a process a session started from one a person started, and misses one that cleared it',
		() => {
			const marked = waiting({ PATH: process.env.PATH, [SESSION_CHILD_ENV]: '1' })
			const cleared = waiting({ PATH: process.env.PATH })
			try {
				expect(processStartedBySession(marked.pid)).toBe(true)
				expect(processStartedBySession(cleared.pid)).toBe(false)
			} finally {
				marked.stop()
				cleared.stop()
			}
		},
	)

	it('says no for a process that cannot be read', () => {
		expect(processStartedBySession(2147483000)).toBe(false)
	})
})
