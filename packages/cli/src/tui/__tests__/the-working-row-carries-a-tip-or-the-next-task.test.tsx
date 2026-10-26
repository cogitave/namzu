import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { LiveActivity, type LiveActivityProps } from '../LiveActivity.js'
import type { Tip } from '../spinner-tips.js'
import type { TipHistory, TipHistoryStore } from '../tip-history.js'
import { useSpinnerTip } from '../use-spinner-tip.js'

const frame = (props: Partial<LiveActivityProps>): string => {
	const harness = render(<LiveActivity activeTools={[]} working animate={false} {...props} />)
	try {
		return harness.lastFrame() ?? ''
	} finally {
		harness.unmount()
	}
}

describe('the tip row under the working row', () => {
	it('shows one dim Tip line under Working', () => {
		const out = frame({ tip: '/goal sets a result.' })
		expect(out).toContain('Working')
		expect(out).toContain('Tip: /goal sets a result.')
		expect(out.indexOf('Working')).toBeLessThan(out.indexOf('Tip:'))
	})

	it('shows nothing extra without a tip', () => {
		expect(frame({})).not.toContain('Tip:')
	})

	it('yields to a retry notice and to a compaction', () => {
		expect(
			frame({ tip: 'hello', waitNotice: { what: 'Provider busy', retryAt: undefined } as never }),
		).not.toContain('Tip:')
		expect(frame({ tip: 'hello', compacting: true })).not.toContain('Tip:')
	})

	it('is left out of the compact layout', () => {
		expect(frame({ tip: 'hello', compact: true })).not.toContain('Tip:')
	})

	it('shows Next instead of the tip, and cuts it to one row', () => {
		const out = frame({
			tip: 'hello',
			nextTask: 'Next: write the migration for the orders table and run it twice',
		})
		expect(out).toContain('Next: write')
		expect(out).not.toContain('Tip:')
		const long = `Next: ${'word '.repeat(60)}`
		const rows = frame({ nextTask: long })
			.split('\n')
			.filter((row) => row.includes('word'))
		expect(rows).toHaveLength(1)
	})
})

/** Let the effect's state update reach the next frame; no clock is involved. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function memoryStore(history: TipHistory): TipHistoryStore & { shown: string[] } {
	const shown: string[] = []
	return {
		shown,
		read: () => history,
		recordLaunch: () => {},
		recordShown: (id) => {
			shown.push(id)
		},
		recordUse: () => {},
	}
}

const tips: readonly Tip[] = [
	{ id: 'one', text: 'first tip', cooldownLaunches: 0, relevant: () => true },
]

function Probe(props: { busy: boolean; enabled: boolean; store: TipHistoryStore }) {
	const tip = useSpinnerTip({
		store: props.store,
		enabled: props.enabled,
		busy: props.busy,
		statusLineSet: false,
		notificationsSet: false,
		lastTurnToolCalls: () => 0,
		tips,
	})
	return <Text>{tip ?? 'none'}</Text>
}

describe('picking the tip', () => {
	const history: TipHistory = { launches: 1, shown: {}, used: {} }

	it('picks when a reply ends, not when it starts, and records it then', async () => {
		const store = memoryStore(history)
		const h = render(<Probe busy={false} enabled store={store} />)
		expect(h.lastFrame()).toBe('none')
		h.rerender(<Probe busy enabled store={store} />)
		expect(h.lastFrame()).toBe('none')
		expect(store.shown).toEqual([])
		h.rerender(<Probe busy={false} enabled store={store} />)
		await settle()
		expect(h.lastFrame()).toBe('first tip')
		expect(store.shown).toEqual(['one'])
		// the next reply starts: the tip holds, and nothing more is recorded
		h.rerender(<Probe busy enabled store={store} />)
		expect(h.lastFrame()).toBe('first tip')
		expect(store.shown).toEqual(['one'])
		h.unmount()
	})

	it('shows and records nothing when tips are off', () => {
		const store = memoryStore(history)
		const h = render(<Probe busy enabled={false} store={store} />)
		h.rerender(<Probe busy={false} enabled={false} store={store} />)
		expect(h.lastFrame()).toBe('none')
		expect(store.shown).toEqual([])
		h.unmount()
	})
})
