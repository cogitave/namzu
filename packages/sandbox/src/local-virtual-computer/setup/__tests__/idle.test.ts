import { describe, expect, it } from 'vitest'
import { defaultSessionRunning, stopIdleWslcSession } from '../idle.js'
import { failure, fakeHost, fakeRunner } from './fakes.js'

const LISTED = 'ID   Creator PID   Display Name\r\n5    59652         wslc-cli-Arda\r\n'
const NONE = 'ID   Creator PID   Display Name\r\n'

const host = (runner: ReturnType<typeof fakeRunner>) =>
	fakeHost({ stateDirectory: '/unused', runner })

describe('defaultSessionRunning', () => {
	it('sees the default session row and nothing else', () => {
		expect(defaultSessionRunning(LISTED)).toBe(true)
		expect(defaultSessionRunning(NONE)).toBe(false)
		expect(defaultSessionRunning('')).toBe(false)
		expect(defaultSessionRunning('7    123           some-other-app\n')).toBe(false)
	})
})

describe('stopIdleWslcSession', () => {
	it('terminates the session when nothing runs', async () => {
		const runner = fakeRunner({
			'wslc system session list': LISTED,
			'wslc list -q': '\r\n',
			'wslc system session terminate': '',
		})
		expect(await stopIdleWslcSession({ host: host(runner) })).toEqual({ outcome: 'stopped' })
		expect(runner.calls).toEqual([
			'wslc system session list',
			'wslc list -q',
			'wslc system session terminate',
		])
	})

	it('answers busy and terminates nothing while any container runs', async () => {
		const runner = fakeRunner({
			'wslc system session list': LISTED,
			'wslc list -q': '4f1e2d3c4b5a\r\n',
		})
		expect(await stopIdleWslcSession({ host: host(runner) })).toEqual({ outcome: 'busy' })
		expect(runner.calls).not.toContain('wslc system session terminate')
	})

	it('answers not-running without asking about containers, which would start the session', async () => {
		const runner = fakeRunner({ 'wslc system session list': NONE })
		expect(await stopIdleWslcSession({ host: host(runner) })).toEqual({ outcome: 'not-running' })
		expect(runner.calls).toEqual(['wslc system session list'])
	})

	it('leaves the session alone when it cannot tell what runs', async () => {
		const runner = fakeRunner({ 'wslc system session list': LISTED, 'wslc list -q': failure(1) })
		await expect(stopIdleWslcSession({ host: host(runner) })).rejects.toThrow()
		expect(runner.calls).not.toContain('wslc system session terminate')
	})
})
