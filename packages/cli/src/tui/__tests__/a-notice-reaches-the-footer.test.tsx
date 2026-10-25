import { Box } from 'ink'
import { render } from 'ink-testing-library'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StatusBar } from '../StatusBar.js'
import { useNotifications } from '../useNotifications.js'
import type { Notice } from '../notifications.js'

/** Move the fake clock, then let React's own (real) scheduler paint what the timers changed. */
async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms)
	await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
	vi.useRealTimers()
})

function Footer({ send }: { readonly send: readonly Notice[] }) {
	const slot = useNotifications()
	useEffect(() => {
		for (const notice of send) slot.add(notice)
	}, [send, slot.add])
	return (
		<Box width={100}>
			<StatusBar
				provider="p"
				model="claude-haiku-4-5"
				state="idle"
				permissionMode="auto"
				notice={slot.current ? { text: slot.current.text } : null}
			/>
		</Box>
	)
}

describe('a notice in the footer', () => {
	it('shows at the right end and gives the row back to the model when it times out', async () => {
		const send = [
			{ key: 'esc', text: 'Esc again to clear', priority: 'immediate', timeoutMs: 1000 } as const,
		]
		const { lastFrame, unmount } = render(<Footer send={send} />)
		await advance(100)
		expect(lastFrame()).toContain('Esc again to clear')
		expect(lastFrame()).not.toContain('claude-haiku-4-5')
		expect(
			lastFrame()
				?.split('\n')
				.filter((l) => l.trim()).length,
		).toBe(1)
		await advance(1000)
		expect(lastFrame()).not.toContain('Esc again to clear')
		expect(lastFrame()).toContain('claude-haiku-4-5')
		unmount()
	})

	it('lets an immediate notice cover the meter and hands the row back to it afterwards', async () => {
		const send: Notice[] = [
			{
				key: 'token-warning',
				text: '12% until auto-compact',
				priority: 'medium',
				timeoutMs: 18_000_000,
			},
			{ key: 'none', text: 'No background agents running', priority: 'immediate', timeoutMs: 2000 },
		]
		const { lastFrame, unmount } = render(<Footer send={send} />)
		await advance(100)
		expect(lastFrame()).toContain('No background agents running')
		await advance(2000)
		expect(lastFrame()).toContain('12% until auto-compact')
		unmount()
	})
})
