import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

import { MSYS_TAG_VARIABLE, signalTagged } from './kill-tree.js'

function tagged(tag: string) {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
		env: { ...process.env, [MSYS_TAG_VARIABLE]: tag },
		stdio: 'ignore',
	})
	const ended = new Promise<NodeJS.Signals | null>((resolve) =>
		child.once('exit', (_code, signal) => resolve(signal)),
	)
	const started = new Promise<void>((resolve) => child.once('spawn', () => resolve()))
	return { child, ended, started }
}

describe.skipIf(process.platform !== 'linux')('signalTagged with several tags', () => {
	it('stops the processes of every named tag in one pass and leaves others alone', async () => {
		const suffix = `${process.pid}-${Date.now()}`
		const a = tagged(`a-${suffix}`)
		const b = tagged(`b-${suffix}`)
		const other = tagged(`other-${suffix}`)
		try {
			// A child's environment is readable from /proc once it has exec'd.
			await Promise.all([a.started, b.started, other.started])
			expect(signalTagged([`a-${suffix}`, `b-${suffix}`], 'SIGKILL')).toBeGreaterThanOrEqual(2)
			expect(await a.ended).toBe('SIGKILL')
			expect(await b.ended).toBe('SIGKILL')
			expect(other.child.exitCode).toBeNull()
			expect(other.child.signalCode).toBeNull()
		} finally {
			other.child.kill('SIGKILL')
		}
	})

	it('signals nothing for an empty list', () => {
		expect(signalTagged([], 'SIGKILL')).toBe(0)
	})
})
