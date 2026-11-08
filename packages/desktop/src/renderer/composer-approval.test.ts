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
const draw = (
	permission: PermissionView,
	folder?: string,
	projectName?: string,
	conversationAllowance?: boolean,
) =>
	renderToStaticMarkup(
		createElement(ComposerApproval, {
			permission,
			count: 1,
			folder,
			projectName,
			conversationAllowance,
			onRespond: () => true,
		}),
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
	expect(html).toContain('Runs in /work/site.')
	// With the project's name, the name stands in for the folder and the folder is the tooltip.
	const named = draw(bash('ls'), '/work/site', 'Site')
	expect(named).toContain('Runs in Site.')
	expect(named).toContain('title="/work/site"')
	expect(draw(bash('rm -rf build'), '/work/site')).toContain('deletes or overwrites files')
})

it('tells the person which keys answer the card', () => {
	expect(draw(bash('ls'))).toContain('Enter accepts. Esc rejects.')
	expect(draw(bash('ls'))).not.toContain('stops this reply')
})

it('does not leave Enter on yes for a command or a file that deletes', () => {
	expect(draw(bash('rm -rf build'))).toContain('Enter rejects it. Esc rejects it too.')
	expect(draw(bash('rm -rf build'))).not.toContain('Enter accepts')
	const removal = draw({
		id: 'r3',
		sessionId: 's',
		projectId: 'p',
		calls: [{ id: 'c3', name: 'delete_file', input: { path: 'a.ts' }, isDestructive: true }],
	})
	expect(removal).toContain('Enter rejects it')
})

it('offers the quiet conversation-wide yes only when the engine keeps it and the call is safe', () => {
	expect(draw(bash('ls'), undefined, undefined, true)).toMatch(
		/class="approval-button approval-instead"[^>]*>Allow for this conversation</,
	)
	// It is a quiet action beside Reject and Accept, never the filled one.
	expect(draw(bash('ls'), undefined, undefined, true)).not.toMatch(
		/data-tone="[a-z]*"[^>]*>Allow for this conversation</,
	)
	expect(draw(bash('ls'), undefined, undefined, false)).not.toContain('Allow for this conversation')
	expect(draw(bash('ls'))).not.toContain('Allow for this conversation')
	expect(draw(bash('rm -rf build'), undefined, undefined, true)).not.toContain(
		'Allow for this conversation',
	)
})

it('says what the conversation-wide yes stops and what it keeps asking', () => {
	// Ordinary asks stop, deletes and commands included; the few that always need a person still come back.
	const html = draw(bash('ls'), undefined, undefined, true)
	const said =
		'Namzu stops asking about most actions in it, deletes and commands included, but still asks before the few things that always need you.'
	expect(html).toContain(`title="Applies to this conversation only. ${said}"`)
	expect(html).toMatch(new RegExp(`class="sr-only">Applies to this conversation only. ${said}<`))
	expect(html).not.toMatch(/will not ask again|for anything/)
})

it('does not offer the conversation-wide yes on a request holding a call the agent always asks about', () => {
	const marked = draw(
		{
			id: 'r4',
			sessionId: 's',
			projectId: 'p',
			calls: [
				{ id: 'c4', name: 'bash', input: { command: 'ls' }, isDestructive: false, alwaysAsk: true },
			],
		},
		undefined,
		undefined,
		true,
	)
	expect(marked).not.toContain('Allow for this conversation')
	// The two ordinary answers are still there.
	expect(marked).toMatch(/data-tone="accept"[^>]*>Accept</)
	expect(marked).toMatch(/data-tone="reject"[^>]*>Reject</)
})

it('starts with Accept announced as unavailable while the click guard runs', () => {
	expect(draw(bash('ls'))).toMatch(
		/aria-disabled="true"[^>]*data-tone="accept"|data-tone="accept"[^>]*aria-disabled="true"/,
	)
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
