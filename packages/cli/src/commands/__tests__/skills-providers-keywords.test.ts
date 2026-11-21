import { describe, expect, it } from 'vitest'

import { providersCommand } from '../providers.js'
import { skillsCommand } from '../skills.js'

function run(command: typeof skillsCommand, rawArgs: string[]) {
	const errors: { message: string }[] = []
	const formatter = {
		name: 'text',
		print: () => undefined,
		info: () => undefined,
		error: (payload: { message: string }) => errors.push(payload),
	}
	const code = command.handler({ ctx: { config: {}, formatter }, rawArgs } as never)
	return { code, errors }
}

describe('skills and providers are areas with a list command', () => {
	it.each([
		['skills', skillsCommand, '`namzu skills list`'],
		['providers', providersCommand, '`namzu providers list`'],
	] as const)(
		'%s with no command, or an unknown one, exits 64 naming list',
		async (_n, cmd, list) => {
			for (const args of [[], ['--json'], ['nope']]) {
				const { code, errors } = run(cmd, args)
				expect(await code).toBe(64)
				expect(errors[0]?.message).toContain(list)
			}
		},
	)

	it('providers list refuses an option it does not know', async () => {
		const { code, errors } = run(providersCommand, ['list', '--wat'])
		expect(await code).toBe(64)
		expect(errors[0]?.message).toContain('--wat')
	})
})
