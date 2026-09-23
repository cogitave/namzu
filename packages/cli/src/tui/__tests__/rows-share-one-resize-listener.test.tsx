/**
 * A long transcript listens for terminal resizes once, not once per row.
 *
 * Each row needs the width beside the gutter to wrap its text and lay out its
 * tables. Reading it through a resize subscription per row passed Node's
 * ten-listener limit, and the "possible EventEmitter memory leak" warning was
 * printed across the operator's screen in a real terminal.
 */

import { render } from 'ink-testing-library'
import { expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { TranscriptMessage } from '../types.js'

it('subscribes to resizes a bounded number of times however many rows there are', () => {
	const messages: TranscriptMessage[] = Array.from({ length: 30 }, (_, i) => ({
		id: `m${i}`,
		role: i % 2 === 0 ? 'user' : 'assistant',
		content: i % 2 === 0 ? `question ${i}` : `| a | b |\n|---|---|\n| ${i} | answer |`,
	}))
	const harness = render(
		<Transcript messages={messages} pending={null} state="idle" settled={0} resetKey={0} />,
	)
	try {
		const stdout = harness.stdout as unknown as NodeJS.EventEmitter
		expect(stdout.listenerCount('resize')).toBeLessThanOrEqual(3)
		expect(harness.lastFrame()).toContain('answer')
	} finally {
		harness.unmount()
	}
})
