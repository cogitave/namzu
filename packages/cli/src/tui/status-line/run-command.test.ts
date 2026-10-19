import { describe, expect, it } from 'vitest'

import { runStatusLineCommand } from './run-command.js'

const node = JSON.stringify(process.execPath)
const base = {
	payload: { model: { id: 'm' } },
	cwd: process.cwd(),
	columns: 77,
}

function run(script: string, extra: { signal?: AbortSignal; timeoutMs?: number } = {}) {
	return runStatusLineCommand({
		...base,
		command: `${node} -e ${JSON.stringify(script)}`,
		signal: extra.signal ?? new AbortController().signal,
		...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
	})
}

describe('runStatusLineCommand', () => {
	it('pipes the payload on stdin and sets COLUMNS', async () => {
		const out = await run(
			"let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).model.id+' '+process.env.COLUMNS))",
		)
		expect(out).toBe('m 77')
	})

	it('is no line for a non-zero exit, even with output', async () => {
		expect(await run("console.log('half');process.exit(3)")).toBeUndefined()
	})

	it('is no line for empty output or a command that cannot be found', async () => {
		expect(await run('')).toBeUndefined()
		const missing = await runStatusLineCommand({
			...base,
			command: 'namzu-no-such-status-line-command',
			signal: new AbortController().signal,
		})
		expect(missing).toBeUndefined()
	})

	it('ignores stderr', async () => {
		expect(await run("console.error('warn');console.log('fine')")).toBe('fine')
	})

	it('stops a command that outlives its deadline', async () => {
		expect(await run('setInterval(()=>{},1000)', { timeoutMs: 100 })).toBeUndefined()
	})

	it('stops a command when its run is aborted', async () => {
		const controller = new AbortController()
		const pending = run('setInterval(()=>{},1000)', {
			signal: controller.signal,
		})
		controller.abort()
		expect(await pending).toBeUndefined()
	})
})
