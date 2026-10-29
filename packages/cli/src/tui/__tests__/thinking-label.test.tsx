/**
 * The reasoning row gets more patient as one stretch runs on, and says how
 * long it took for two seconds once it ends. Fake clock throughout.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'
import { thinkingLabel, thoughtForLabel } from '../thinking-label.js'

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
	})
	vi.setSystemTime(new Date('2026-10-28T09:00:00Z'))
})
afterEach(() => {
	vi.useRealTimers()
})

it('steps the label at 10, 20, 30 and 45 seconds', () => {
	expect(thinkingLabel(0)).toBe('thinking')
	expect(thinkingLabel(9_999)).toBe('thinking')
	expect(thinkingLabel(10_000)).toBe('still thinking')
	expect(thinkingLabel(20_000)).toBe('thinking more')
	expect(thinkingLabel(30_000)).toBe('thinking some more')
	expect(thinkingLabel(45_000)).toBe('deep in thought')
})

it('rounds the settled duration to whole seconds, at least one', () => {
	expect(thoughtForLabel(200)).toBe('thought for 1s')
	expect(thoughtForLabel(12_400)).toBe('thought for 12s')
})

function frame(tree: ReturnType<typeof render>): string {
	return tree.lastFrame() ?? ''
}

it('escalates on screen, then shows the settled row for two seconds', async () => {
	const props = { activeTools: [], working: true, animate: false } as const
	const tree = render(<LiveActivity {...props} thinking="weighing options" />)
	expect(frame(tree)).toContain('thinking · weighing options')
	vi.setSystemTime(Date.now() + 21_000)
	tree.rerender(<LiveActivity {...props} thinking="weighing options" />)
	expect(frame(tree)).toContain('thinking more · weighing options')

	tree.rerender(<LiveActivity {...props} thinking={null} />)
	expect(frame(tree)).toContain('thought for 21s')

	// Let the effect that schedules the clearing redraw run first.
	await vi.advanceTimersByTimeAsync(0)
	await vi.advanceTimersByTimeAsync(2_100)
	// React schedules the redraw on a real macrotask.
	await new Promise((resolve) => setImmediate(resolve))
	expect(frame(tree)).not.toContain('thought for')
	tree.unmount()
})

it('starts the count again for a new stretch', () => {
	const props = { activeTools: [], working: true, animate: false } as const
	const tree = render(<LiveActivity {...props} thinking="" />)
	vi.setSystemTime(Date.now() + 12_000)
	tree.rerender(<LiveActivity {...props} thinking="" />)
	expect(frame(tree)).toContain('still thinking…')
	tree.rerender(<LiveActivity {...props} thinking={null} />)
	tree.rerender(<LiveActivity {...props} thinking="" />)
	expect(frame(tree)).toContain('thinking…')
	expect(frame(tree)).not.toContain('still thinking')
	tree.unmount()
})
