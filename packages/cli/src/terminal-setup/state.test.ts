import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { readTerminalState, terminalStatePath, updateTerminalState } from './state.js'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'namzu-state-'))

describe('terminal state updates', () => {
	it('keeps both records when two launches update one after the other', () => {
		const home = scratch()
		const record = { startedAt: 1, version: '1', host: 'h', platform: 'linux' }
		updateTerminalState((s) => ({ ...s, fullscreenBootPending: { '1': record } }), home)
		updateTerminalState(
			(s) => ({ ...s, fullscreenBootPending: { ...s.fullscreenBootPending, '2': record } }),
			home,
		)
		expect(Object.keys(readTerminalState(home).fullscreenBootPending ?? {})).toEqual(['1', '2'])
		expect(existsSync(`${terminalStatePath(home)}.lock`)).toBe(false)
	})

	it('takes over a lock left by a launch that crashed', () => {
		const home = scratch()
		updateTerminalState((s) => s, home)
		const lock = `${terminalStatePath(home)}.lock`
		writeFileSync(lock, '1')
		const old = new Date(Date.now() - 60_000)
		utimesSync(lock, old, old)
		updateTerminalState((s) => ({ ...s, shiftEnterInstalled: true }), home)
		expect(readTerminalState(home).shiftEnterInstalled).toBe(true)
		expect(existsSync(lock)).toBe(false)
	})
})
