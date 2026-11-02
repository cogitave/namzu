import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import type { Adapter } from '../adapters/types.js'
import { ComputerUseStoppedError } from '../errors.js'
import { STOPPED_TEXT } from '../foreground/ladder.js'
import { FakeMonitor, makeLadder } from './foreground-fakes.js'

const adapter: Adapter = {
	capabilities: {
		displayServer: 'win32',
		screenshot: true,
		mouse: true,
		keyboard: true,
		cursorPosition: true,
		clipboard: false,
	},
	getDisplayGeometry: async () => ({ width: 1, height: 1, scaleFactor: 1 }),
	execute: async () => ({ type: 'ok' }),
}

describe('the host and the Escape stop', () => {
	it('fails every call with the same fixed message after Escape, until the next turn', async () => {
		const monitor = new FakeMonitor()
		const { ladder } = makeLadder({ monitor })
		const host = new SubprocessComputerUseHost({
			adapter,
			foreground: { ladder },
		})
		host.beginTurn('t1')
		monitor.during = { inputs: 1, escapes: 1 }
		await ladder.run({ subject: { app: 'x' } }, async () => 1)
		monitor.during = { inputs: 0, escapes: 0 }
		await expect(host.execute({ type: 'screenshot' })).rejects.toBeInstanceOf(
			ComputerUseStoppedError,
		)
		await expect(host.getDisplayGeometry()).rejects.toThrow(STOPPED_TEXT)
		host.beginTurn('t1')
		await expect(host.execute({ type: 'screenshot' })).rejects.toThrow(STOPPED_TEXT)
		host.beginTurn('t2')
		await expect(host.execute({ type: 'screenshot' })).resolves.toEqual({
			type: 'ok',
		})
	})

	it('releases the input monitor when the turn ends', async () => {
		const monitor = new FakeMonitor()
		const { ladder } = makeLadder({ monitor })
		const host = new SubprocessComputerUseHost({
			adapter,
			foreground: { ladder },
		})
		await ladder.run({ subject: { app: 'x' } }, async () => 1)
		await host.endTurn()
		expect(monitor.disposed).toBe(1)
	})
})
