/** The open group's blinking dot is motion: reduced motion keeps it lit and still. */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('ink', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ink')>()
	return {
		...actual,
		useStdout: () => {
			const real = actual.useStdout()
			return { ...real, stdout: Object.assign(Object.create(real.stdout), { isTTY: true }) }
		},
	}
})

const { ReadSearchGroup } = await import('../ReadSearchGroup.js')
const { setReducedMotion } = await import('../motion.js')
const { EMPTY_GROUP, foldOp } = await import('../read-search-group.js')

beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', undefined)
	vi.stubEnv('TERM', 'xterm-256color')
	vi.useFakeTimers({
		toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
	})
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
	setReducedMotion(false)
})

async function dots(): Promise<string[]> {
	const group = foldOp(EMPTY_GROUP, { kind: 'search', hint: '"a"' }, 0)
	const view = render(
		<ReadSearchGroup
			message={{ id: 'g', role: 'tool', content: '', pending: true, group }}
			now={() => 0}
		/>,
	)
	const marks: string[] = []
	for (let i = 0; i < 8; i += 1) {
		marks.push((view.lastFrame() ?? '').startsWith('●') ? 'on' : 'off')
		await vi.advanceTimersByTimeAsync(300)
	}
	view.unmount()
	return marks
}

it('blinks while motion is allowed', async () => {
	expect(new Set(await dots()).size).toBe(2)
})

it('stays lit when motion is reduced', async () => {
	setReducedMotion(true)
	expect(await dots()).toEqual(Array(8).fill('on'))
})
