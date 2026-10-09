import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import { ComposerApproval } from './composer-approval.js'

const bash = (command: string): PermissionView => ({
	id: 'r1',
	sessionId: 's',
	projectId: 'p',
	calls: [{ id: 'c1', name: 'bash', input: { command }, isDestructive: false }],
})
const draw = (permission: PermissionView, folder?: string) =>
	renderToStaticMarkup(
		createElement(ComposerApproval, { permission, count: 1, folder, onRespond: () => true }),
	)

it('makes Accept the one filled answer and says what the edit button does', () => {
	const html = draw(bash('ls'), '/work/site')
	expect(html).toMatch(/data-tone="accept"[^>]*>Accept</)
	expect(html).toMatch(/data-tone="reject"[^>]*>Reject</)
	expect(html).toContain('Tell Namzu what to do instead')
	expect(html).not.toMatch(/>Edit</)
})

it('names the folder a command runs in and what it can change', () => {
	const html = draw(bash('ls'), '/work/site')
	expect(html).toContain('Runs on your computer in /work/site.')
	expect(draw(bash('rm -rf build'), '/work/site')).toContain('deletes or overwrites files')
})

it('tells the person which keys answer the card', () => {
	expect(draw(bash('ls'))).toContain('Enter accepts. Esc stops this reply')
})

it('explains the added-lines badge to a screen reader and on hover', () => {
	const html = draw({
		id: 'r2',
		sessionId: 's',
		projectId: 'p',
		calls: [
			{
				id: 'c2',
				name: 'write',
				input: { path: 'index.html' },
				isDestructive: false,
				preview: { path: '/work/index.html', before: null, after: 'a\nb\n' },
			},
		],
	})
	expect(html).toContain('aria-label="2 lines added"')
	expect(html).toContain('title="2 lines added"')
})
