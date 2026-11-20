import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import type { QuestionItem } from '../shared/question-protocol.js'
import { ComposerQuestion } from './composer-question.js'

const item = (over: Partial<QuestionItem> = {}): QuestionItem => ({
	id: 'q1',
	question: 'Who is the audience?',
	header: 'Audience',
	multiSelect: false,
	allowFreeText: true,
	options: [
		{ id: 'opt_1', label: 'Board', description: 'High level, few slides', recommended: true },
		{ id: 'opt_2', label: 'Engineers', description: 'Details and diagrams' },
	],
	...over,
})
const ask = (...questions: QuestionItem[]): PermissionView => ({
	id: 'r1',
	sessionId: 's',
	projectId: 'p',
	calls: [
		{
			id: 'r1',
			name: 'ask_user_question',
			input: { questions },
			isDestructive: false,
			alwaysAsk: true,
		},
	],
	question: { questions },
})
const draw = (permission: PermissionView, count = 1) =>
	renderToStaticMarkup(createElement(ComposerQuestion, { permission, count, onAnswer: () => true }))

it('draws the question, each choice with its line, the recommended one named, and Other', () => {
	const html = draw(ask(item()))
	expect(html).toContain('Who is the audience?')
	expect(html).toContain('role="radiogroup"')
	expect(html).toMatch(/role="radio"[^>]*>[\s\S]*?Board/)
	expect(html).toContain('High level, few slides')
	expect(html).toContain('Details and diagrams')
	// The recommendation is a word, not only a colour, and sits on the option the model flagged.
	expect(html.match(/Recommended/g)).toHaveLength(1)
	expect(html).toMatch(/data-recommended="true"[\s\S]*?Board/)
	expect(html).toContain('Say it in your own words')
	// Numbers to press are on the rows, and named for assistive tools.
	expect(html).toContain('aria-keyshortcuts="1"')
	expect(html).toContain('aria-keyshortcuts="3"')
})

it('draws a multiple choice as checkboxes and leaves Other out where the question forbids it', () => {
	const html = draw(ask(item({ multiSelect: true, allowFreeText: false })))
	expect(html).toContain('role="group"')
	expect(html).toMatch(/role="checkbox"/)
	expect(html).not.toContain('role="radio"')
	expect(html).not.toContain('own words')
})

it('shows one question at a time with a pager, and Next until the last one', () => {
	const html = draw(
		ask(item(), item({ id: 'q2', question: 'Which environments?', header: 'Environment' })),
	)
	expect(html).toContain('1 of 2')
	expect(html).toContain('aria-label="Next question"')
	expect(html).toContain('Who is the audience?')
	expect(html).not.toContain('Which environments?')
	expect(html).toMatch(/data-action="next"/)
	expect(html).not.toMatch(/data-action="submit"/)
})

it('has Skip on Esc and a Send that waits for an answer, with the key that sends from anywhere', () => {
	const html = draw(ask(item()))
	expect(html).toMatch(
		/data-action="skip"[^>]*>Skip<span class="approval-key" aria-hidden="true">Esc</,
	)
	expect(html).toMatch(/data-action="submit"[^>]*disabled/)
	expect(html).toMatch(/aria-keyshortcuts="Control\+Enter"/)
})

it('names how many requests wait when there is more than this one', () => {
	expect(draw(ask(item()), 3)).toContain('1 of 3 waiting')
	expect(draw(ask(item()), 1)).not.toContain('waiting')
})

it('uses the approval card’s own sizes and no accent fill', () => {
	const css = readFileSync(new URL('./composer-question.css', import.meta.url), 'utf8')
	expect(css).not.toMatch(/--accent\b/)
	expect(css).not.toMatch(/font-size:\s*\d/)
	expect(css).toMatch(/var\(--ask-button-radius\)/)
})
