import { describe, expect, it } from 'vitest'
import { ancestorsOf, defaultParentPid, runsUnderAny } from './process-ancestry.js'

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
