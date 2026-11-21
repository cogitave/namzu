import { describe, expect, it, vi } from 'vitest'

import { scheduleCommand } from '../../commands/schedule.js'
import type { Formatter } from '../../output/index.js'

function run(rawArgs: string[]) {
	const errors: { message: string }[] = []
	const formatter = {
		name: 'text',
		print: () => undefined,
		info: () => undefined,
		error: (payload: { message: string }) => errors.push(payload),
	} as unknown as Formatter
	const code = scheduleCommand.handler({ ctx: { config: {}, formatter }, rawArgs } as never)
	return { code, errors }
}

describe('schedule commands are keywords', () => {
	it('names the new spelling for every old one and exits 64', async () => {
		const expected: Record<string, string> = {
			'run-now': 'namzu schedule run <job>',
			install: 'namzu schedule service install',
			uninstall: 'namzu schedule service uninstall',
			status: 'namzu schedule service status',
			start: 'namzu schedule service start',
			stop: 'namzu schedule service stop',
			logs: 'namzu schedule service logs',
		}
		for (const [old, now] of Object.entries(expected)) {
			const { code, errors } = run([old, 'x'])
			expect(await code, old).toBe(64)
			expect(errors[0]?.message, old).toBe(`This command is now \`${now}\`.`)
		}
	})

	it('needs a service command under service', async () => {
		const { code, errors } = run(['service'])
		expect(await code).toBe(64)
		expect(errors[0]?.message).toContain('schedule service command is required')
		vi.clearAllMocks()
	})
})
