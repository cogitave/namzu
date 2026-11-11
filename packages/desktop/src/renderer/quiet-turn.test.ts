import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import { foldLabel, foldParts } from './transcript-motion.js'
import { Transcript } from './transcript.js'

const here = import.meta.dirname
const css = (name: string) => readFileSync(join(here, name), 'utf8')

function begin(): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), { kind: 'prompt', sessionId: 's', prompt: 'Go', at: 1000 }),
		{ kind: 'state', sessionId: 's', running: true, queued: [] },
	)
}
function update(thread: ThreadState, value: AcpSessionUpdate, at = 2000): ThreadState {
	return applyEvent(thread, { kind: 'update', sessionId: 's', projectId: 'p', update: value, at })
}
function command(thread: ThreadState, id: string, at: number): ThreadState {
	const view = { kind: 'terminal' as const, command: id, output: 'ok' }
	return update(
		update(
			thread,
			{ kind: 'tool_call', toolCallId: id, title: 'bash', status: 'pending', view },
			at,
		),
		{ kind: 'tool_call', toolCallId: id, title: 'bash', status: 'completed', view },
		at,
	)
}
function failedCommand(thread: ThreadState, id: string, at: number): ThreadState {
	const view = { kind: 'terminal' as const, command: id, output: 'no' }
	return update(
		update(
			thread,
			{ kind: 'tool_call', toolCallId: id, title: 'bash', status: 'pending', view },
			at,
		),
		{ kind: 'tool_call', toolCallId: id, title: 'bash', status: 'failed', view },
		at,
	)
}
function finished(thread: ThreadState): ThreadState {
	const answered = update(
		thread,
		{ kind: 'agent_message_chunk', text: 'Done.', messageId: 'a' },
		8000,
	)
	return applyEvent(update(answered, { kind: 'turn_ended', stopReason: 'end_turn' }, 9000), {
		kind: 'state',
		sessionId: 's',
		running: false,
		queued: [],
	})
}
const render = (thread: ThreadState) => renderToStaticMarkup(createElement(Transcript, { thread }))

describe('the fold line of a finished turn', () => {
	const two = () => finished(command(command(begin(), 'a', 3000), 'b', 4000))

	it('says what the work was, and the time apart from it', () => {
		expect(foldParts(two(), 1)).toEqual({ text: 'Ran 2 commands', duration: '8s', sentence: true })
		expect(foldLabel(two(), 1)).toBe('Ran 2 commands · 8s')
		const html = render(two())
		expect(html).toContain('class="transcript-phase-text">Ran 2 commands<')
		expect(html).toMatch(/class="turn-activity-elapsed"[^>]*>· 8s</)
		expect(html).toContain('data-sentence=""')
	})

	it('draws the rows directly when its one group would say the same sentence again', () => {
		const html = render(two())
		expect(html).not.toContain('tool-run-trigger')
		expect(html).toContain('data-sole="true"')
		expect(html.match(/data-tool-call-id=/g)).toHaveLength(2)
	})

	it('does not draw the sentence twice when its one group only adds "1 failed"', () => {
		const html = render(finished(failedCommand(command(begin(), 'a', 3000), 'b', 4000)))
		expect(html).toContain('data-sole="true"')
		expect(html).not.toContain('tool-run-trigger')
		expect(html).not.toContain('1 failed')
	})

	it('keeps the group when narration splits the work into more than one', () => {
		let thread = command(begin(), 'a', 3000)
		thread = update(
			thread,
			{ kind: 'agent_message_chunk', text: 'Next', phase: 'commentary', messageId: 'n' },
			3500,
		)
		thread = finished(command(command(thread, 'b', 4000), 'c', 5000))
		const html = render(thread)
		expect(html).toContain('tool-run-trigger')
		expect(html).not.toContain('data-sole')
	})

	it('keeps the plain form for a turn that did not end well', () => {
		let thread = command(command(begin(), 'a', 3000), 'b', 4000)
		thread = applyEvent(update(thread, { kind: 'turn_ended', stopReason: 'cancelled' }, 9000), {
			kind: 'state',
			sessionId: 's',
			running: false,
			queued: [],
		})
		expect(foldParts(thread, 1).sentence).toBe(false)
		expect(foldLabel(thread, 1)).toBe('Stopped · 8s · 2 steps')
	})
})

describe('the look of a finished turn, as the styles say it', () => {
	const line = css('turn-result-line.css')
	const block = (source: string, selector: string) => {
		const at = source.indexOf(`${selector} {`)
		expect(at, selector).toBeGreaterThanOrEqual(0)
		return source.slice(at, source.indexOf('}', at))
	}

	it('the result line at rest is one 32 px row of text: no border, fill, or rule', () => {
		const rest = block(line, '.turn-result')
		expect(rest).toContain('min-height: 32px')
		expect(rest).not.toMatch(/border|background:|box-shadow/)
		expect(line).not.toContain('data-check="error"')
	})

	it('the row ends at the column edge, so the hover fill stays inside it', () => {
		expect(block(line, '.turn-result')).toContain('margin: 0 0 16px -4px')
	})

	it('the reply action row gives the line room without moving when it shows', () => {
		const row = block(
			line,
			'.normal-transcript .message.is-assistant:has(+ .turn-result) > .message-footer',
		)
		expect(row).toContain('height: 16px')
		expect(row).toContain('z-index: 1')
	})

	it('the whole row takes a soft fill with 8 px corners on hover and on keyboard focus', () => {
		expect(line).toMatch(
			/\.turn-result:has\(\.turn-result-more\[data-popup-open\]\) \{\s*border-radius: var\(--radius-control\)/,
		)
		expect(line).toMatch(
			/\.turn-result\[data-opens\]:hover[^{]*\{[^}]*background: var\(--turn-result-fill\)/,
		)
		expect(line).toContain('.turn-result:has(.turn-result-main:focus-visible)')
	})

	it('the menu button is drawn on hover, focus inside or an open menu, and always without hover', () => {
		expect(block(line, '.turn-result-more')).toContain('opacity: 0')
		for (const reveal of [
			'.turn-result:hover .turn-result-more',
			'.turn-result:focus-within .turn-result-more',
			'.turn-result-more[data-popup-open]',
		])
			expect(line).toContain(reveal)
		expect(line).toMatch(/@media \(hover: none\) \{\s*\.turn-result-more \{\s*opacity: 1/)
	})

	it('the closed fold has no rule and the open one separates work from answer', () => {
		const motion = css('transcript-motion.css')
		expect(block(motion, '.normal-transcript .activity-trigger')).toContain('border-bottom: 0')
		const flat = motion.replace(/\s+/g, ' ')
		expect(flat).toMatch(
			/\.activity-trigger:not\(\[data-live\]\) \+ \[data-slot="collapsible-panel"\] \.activity-entries \{[^}]*border-bottom: 1px solid/,
		)
	})

	it('inline code keeps its fill and loses its border; a file chip has a hover state', () => {
		const style = css('style.css')
		const code = block(style, '.chat-markdown :not(pre) > code')
		expect(code).toContain('background: var(--muted)')
		expect(code).not.toContain('border:')
		expect(style).toContain('code:has(.message-file-link:hover)')
	})

	it("the person's message has 14 px corners and may take 85% of the column", () => {
		const message = readFileSync(join(here, 'message.tsx'), 'utf8')
		expect(message).toContain('group-[.is-user]:max-w-[85%] group-[.is-user]:rounded-xl')
		expect(css('theme.css')).toContain('--radius-xl: calc(var(--radius) + 4px)')
		expect(css('theme.css')).toContain('--radius: 0.625rem')
	})

	it('the fold sentence is as wide as its words, and the time shows on a screen with no hover', () => {
		const motion = css('transcript-motion.css')
		expect(block(motion, '.normal-transcript .activity-trigger[data-sentence]')).toContain(
			'width: max-content',
		)
		expect(motion).toMatch(
			/@media \(hover: none\) \{\s*\.normal-transcript \.message-time \{\s*opacity: 1;/,
		)
	})
})
