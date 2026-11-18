import { describe, expect, it } from 'vitest'

import { fitCommand, withoutCdToCwd } from './shell-display.js'

const CWD = '/work/app'

describe('a command as it reads on screen', () => {
	it('leaves out a leading cd to the working folder, in every spelling of it', () => {
		for (const lead of [
			'cd /work/app &&',
			'cd /work/app/ &&',
			"cd '/work/app' &&",
			'cd "/work/app" &&',
			'cd -- /work/app &&',
			'cd /work/app;',
			'cd . &&',
			'cd /work/app/src/.. &&',
		])
			expect(withoutCdToCwd(`${lead} npm test`, CWD), lead).toBe('npm test')
	})

	it('keeps the rest of the line as written, pipes and chains included', () => {
		expect(withoutCdToCwd('cd /work/app && npm test 2>&1 | tail -5 && echo ok', CWD)).toBe(
			'npm test 2>&1 | tail -5 && echo ok',
		)
	})

	it('keeps a cd that goes somewhere else, since it changes what follows', () => {
		for (const command of [
			'cd /work/other && npm test',
			'cd /work/app/packages/a && npm test',
			'cd .. && ls',
			'cd ~ && ls',
			'cd $HOME && ls',
		])
			expect(withoutCdToCwd(command, CWD), command).toBe(command)
	})

	it('keeps a command that is nothing but the cd, and one that does not begin with it', () => {
		expect(withoutCdToCwd('cd /work/app', CWD)).toBe('cd /work/app')
		expect(withoutCdToCwd('cd /work/app && ', CWD)).toBe('cd /work/app && ')
		expect(withoutCdToCwd('echo cd /work/app && ls', CWD)).toBe('echo cd /work/app && ls')
		expect(withoutCdToCwd('ls && cd /work/app && ls', CWD)).toBe('ls && cd /work/app && ls')
	})

	it('does nothing without a working folder', () => {
		expect(withoutCdToCwd('cd /work/app && ls', undefined)).toBe('cd /work/app && ls')
	})
})

describe('a command cut to a line', () => {
	it('comes back whole when it fits', () => {
		expect(fitCommand('npm test', 60)).toBe('npm test')
	})

	it('ends after a whole word, with a mark that says it goes on', () => {
		expect(
			fitCommand('pnpm --filter @namzu/cli test -- src/tui/links.test.ts --reporter verbose', 40),
		).toBe('pnpm --filter @namzu/cli test -- …')
	})

	it('never ends inside a quoted string, or on an operator', () => {
		expect(fitCommand('node -e "console.log(1 + 2)" && npm test', 22)).toBe('node -e …')
		expect(fitCommand('echo one two three four && npm test', 24)).toBe('echo one two three …')
		expect(fitCommand('make build && make test && make lint', 20)).toBe('make build …')
	})

	it('cuts inside only a first word that is longer than the room', () => {
		expect(fitCommand('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
	})
})
