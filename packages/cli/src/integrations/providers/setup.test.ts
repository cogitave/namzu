import { describe, expect, it } from 'vitest'
import { runSetupCommand } from './setup.js'

describe('setup process ownership', () => {
	it('passes arguments literally and bounds output', async () => {
		const result = await runSetupCommand(
			process.execPath,
			['-e', 'process.stdout.write(process.argv[1]+"x".repeat(9000))', '$(not-a-shell)'],
			{ cwd: process.cwd(), signal: new AbortController().signal, timeoutMs: 3000 },
		)
		expect(result.code).toBe(0)
		expect(result.output).toHaveLength(8000)
	})
	it('reports missing executables and kills timed-out children', async () => {
		const signal = new AbortController().signal
		expect(
			(
				await runSetupCommand('/nonexistent/namzu-setup', [], {
					cwd: process.cwd(),
					signal,
					timeoutMs: 100,
				})
			).code,
		).toBeNull()
		expect(
			(
				await runSetupCommand(process.execPath, ['-e', 'setInterval(()=>{},100)'], {
					cwd: process.cwd(),
					signal,
					timeoutMs: 100,
				})
			).code,
		).toBeNull()
	})
	it('refuses an already cancelled installation before spawning', async () => {
		const abort = new AbortController()
		abort.abort(new Error('cancelled'))
		expect(() =>
			runSetupCommand(process.execPath, [], {
				cwd: process.cwd(),
				signal: abort.signal,
				timeoutMs: 100,
			}),
		).toThrow('cancelled')
	})
})
