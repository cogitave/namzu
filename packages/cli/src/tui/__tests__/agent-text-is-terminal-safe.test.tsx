/** Agent-authored source stays exact in memory while every painted form is inert. */

import { render } from 'ink-testing-library'
import { expect, it } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'
import { PermissionOverlay } from '../PermissionOverlay.js'
import { Transcript, renderedDetailLines } from '../Transcript.js'
import { transcriptLines } from '../live-window.js'
import type { TranscriptMessage } from '../types.js'

const BEL = String.fromCodePoint(0x07)
const CSI = String.fromCodePoint(0x9b)
const BIDI = String.fromCodePoint(0x202e)
const unsafe = `before${BEL} bell ${CSI}31m colour ${BIDI}reordered`
const visible = 'before\\u{0007} bell \\u{009b}31m colour \\u{202e}reordered'

function expectSafe(frame: string): void {
	expect(frame).toContain(visible)
	expect(frame).not.toContain(BEL)
	expect(frame).not.toContain(CSI)
	expect(frame).not.toContain(BIDI)
}

it('projects rich, raw, metadata and detail views without mutating transcript source', () => {
	const messages: readonly TranscriptMessage[] = Object.freeze([
		Object.freeze({
			id: 'assistant',
			role: 'assistant' as const,
			content: unsafe,
		}),
		Object.freeze({
			id: 'tool',
			role: 'tool' as const,
			content: unsafe,
			meta: unsafe,
			detail: Object.freeze([unsafe]),
			detailExpanded: true,
		}),
	])
	const original = structuredClone(messages)
	const harness = render(
		<Transcript messages={messages} pending={null} state="idle" settled={0} resetKey={0} />,
	)
	try {
		expectSafe(harness.lastFrame() ?? '')
		harness.rerender(
			<Transcript messages={messages} pending={null} state="idle" settled={0} resetKey={1} raw />,
		)
		expectSafe(harness.lastFrame() ?? '')
		expect(messages).toEqual(original)
		expectSafe(renderedDetailLines(messages[1] as TranscriptMessage).join('\n'))
		expectSafe(transcriptLines(messages, true).join('\n'))
	} finally {
		harness.unmount()
	}
})

it('projects the permission summary and preview before an operator decides', () => {
	const request = Object.freeze([
		Object.freeze({
			id: 'call',
			name: unsafe,
			summary: unsafe,
			preview: Object.freeze([unsafe]),
			isDestructive: true,
		}),
	])
	const original = structuredClone(request)
	const harness = render(<PermissionOverlay toolCalls={request} />)
	try {
		expectSafe(harness.lastFrame() ?? '')
		expect(request).toEqual(original)
	} finally {
		harness.unmount()
	}
})

it('projects the in-flight tool label before it becomes a transcript row', () => {
	const tools = Object.freeze([Object.freeze({ id: 'call', label: unsafe, startedAt: Date.now() })])
	const original = structuredClone(tools)
	const harness = render(<LiveActivity activeTools={tools} thinking={false} />)
	try {
		expectSafe(harness.lastFrame() ?? '')
		expect(tools).toEqual(original)
	} finally {
		harness.unmount()
	}
})
