/**
 * The Working label turns red when the model has gone quiet, and goes back on
 * the next token. Rendered with motion on and a fake clock; the pure maths is
 * in stall-colour.test.ts, this proves it reaches the screen and where it is
 * switched off.
 */

import { createRequire } from 'node:module'

import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { ActiveTool } from '../LiveActivity.js'

vi.mock('ink', async (importOriginal) => {
	const actual = await importOriginal<typeof import('ink')>()
	return {
		...actual,
		// The test stdout is not a terminal; the label only moves on one.
		useStdout: () => {
			const real = actual.useStdout()
			return { ...real, stdout: Object.assign(Object.create(real.stdout), { isTTY: true }) }
		},
	}
})

const { LiveActivity } = await import('../LiveActivity.js')

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level

/** The stall red as chalk writes it, 24-bit foreground. */
const RED = '38;2;171;43;63'

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', '3')
	vi.stubEnv('TERM', 'xterm-256color')
	vi.useFakeTimers({
		toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
	})
	vi.setSystemTime(new Date('2026-10-24T09:00:00Z'))
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

/**
 * Move the fake clock `ms` forward one second at a time, letting React commit
 * (a real, unfaked macrotask) after each step. The tint eases toward its target
 * once per render, so how many renders happen inside a window must not depend
 * on how busy the machine is: a loaded runner batching several ticks into one
 * render would reach the threshold later and fail without anything being broken.
 */
async function advance(ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= 1_000) {
		await vi.advanceTimersByTimeAsync(Math.min(1_000, left))
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
}

const tool: ActiveTool = {
	id: 't1',
	label: 'Run tests',
	startedAt: Date.now(),
}

it('stays plain for the first ten silent seconds, then reddens, then resets on a token', async () => {
	const view = render(<LiveActivity activeTools={[]} working tokens={5} />)
	try {
		await advance(8_000)
		expect(view.lastFrame() ?? '').not.toContain(RED)

		await advance(22_000)
		expect(view.lastFrame() ?? '', 'no token for 30 s, the label should be red').toContain(RED)

		view.rerender(<LiveActivity activeTools={[]} working tokens={6} />)
		await advance(240)
		expect(view.lastFrame() ?? '', 'the next token clears the tint').not.toContain(RED)
	} finally {
		view.unmount()
	}
})

it('never reddens while a tool runs, the model thinks, or a compaction runs', async () => {
	const cases = [
		<LiveActivity key="tool" activeTools={[tool]} working />,
		<LiveActivity key="think" activeTools={[]} working thinking="weighing options" />,
		<LiveActivity key="compact" activeTools={[]} working compacting />,
	]
	for (const element of cases) {
		const view = render(element)
		try {
			await advance(40_000)
			expect(view.lastFrame() ?? '', `${element.key} should stay un-tinted`).not.toContain(RED)
		} finally {
			view.unmount()
		}
	}
})

it('does not count the time spent waiting for the person', async () => {
	const view = render(<LiveActivity activeTools={[]} working tokens={5} />)
	try {
		await advance(8_000)
		view.rerender(<LiveActivity activeTools={[]} working tokens={5} waitingForYou />)
		await advance(60_000)
		view.rerender(<LiveActivity activeTools={[]} working tokens={5} />)
		await advance(240)
		expect(view.lastFrame() ?? '', 'a one-minute approval is not a stalled model').not.toContain(
			RED,
		)
	} finally {
		view.unmount()
	}
})
