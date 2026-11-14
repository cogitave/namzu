import { readFileSync } from 'node:fs'
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

it('makes Accept the one filled answer and keeps what the edit button does behind the menu', () => {
	const html = draw(bash('ls'), '/work/site')
	expect(html).toMatch(/data-tone="accept"[^>]*>Accept</)
	expect(html).toMatch(/data-tone="reject"[^>]*>Reject</)
	// The keys that are bound are drawn on the buttons, and hidden from the button's name.
	expect(html).toMatch(
		/data-tone="reject"[^>]*>Reject<span class="approval-key" aria-hidden="true">Esc</,
	)
	expect(html).toMatch(
		/data-tone="accept"[\s\S]*?<span class="approval-key" aria-hidden="true">Ctrl\+Enter</,
	)
	// The note field and the other choices are one click away, on the box's "..." menu.
	expect(html).toContain('aria-label="More about this request"')
	expect(html).not.toMatch(/>Edit</)
})

it('is one card with the question, its target and where a command runs', () => {
	const html = draw(bash('ls'), '/work/site')
	expect(html).toContain('Run this command?')
	// A command of one line has the path-style row; it is not drawn twice.
	expect(html).toContain('class="approval-path" data-kind="command"')
	expect(html).not.toContain('class="approval-box"')
	expect(html).not.toContain('Waiting for your decision')
	expect(html.match(/class="approval-card"/g)).toHaveLength(1)
	expect(html).toContain('Runs in /work/site.')
	// With the project's name, the name stands in for the folder and the folder is the tooltip.
	const named = draw(bash('ls'), '/work/site', 'Site')
	expect(named).toContain('Runs in Site.')
	expect(named).toContain('title="/work/site"')
})

it('puts the kernel flag right after the question, with a warning mark', () => {
	const html = draw(bash('rm -rf build'), '/work/site')
	expect(html).toContain('class="approval-flag"')
	expect(html).toContain('Looks like it deletes or overwrites files.')
	expect(html.indexOf('approval-flag')).toBeGreaterThan(html.indexOf('approval-head'))
	expect(html.indexOf('approval-flag')).toBeLessThan(html.indexOf('approval-footer'))
	expect(draw(bash('ls'), '/work/site')).not.toContain('approval-flag')
})

it('never holds Accept for scrolling: a long command is four rows and a link that states the rest', () => {
	const long = Array.from({ length: 24 }, (_, i) => `# step ${i + 1}`).join('\n')
	const html = draw(bash(`${long}\necho done`), '/work/site')
	expect(html.match(/class="approval-row"/g)).toHaveLength(4)
	expect(html).toContain('Show all 25 lines')
	expect(html).not.toMatch(/Scroll (through|to)/)
	// The only hold is the click guard, which every card starts under.
	expect(html).toMatch(/data-held="true"[^>]*>Accept</)
})

it('draws the first rows of an edit from the change itself', () => {
	const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
	const after = before.replace('line 12', 'LINE 12')
	const html = draw(
		{
			id: 'r5',
			sessionId: 's',
			projectId: 'p',
			calls: [
				{
					id: 'c5',
					name: 'edit',
					input: { path: '/work/src/a.ts', old_string: 'line 12', new_string: 'LINE 12' },
					isDestructive: false,
					preview: { path: '/work/src/a.ts', before, after },
				},
			],
		},
		'/work',
	)
	expect(html).toContain('>Edit a.ts?<')
	// The path is out of the title, in its row.
	expect(html).toContain('class="approval-path" data-kind="file"')
	expect(html).toContain('src/a.ts')
	expect(html).toContain('data-kind="remove"')
	expect(html).toContain('data-kind="add"')
	expect(html).toContain('LINE 12')
	expect(html).toMatch(/Show all \d+ lines/)
})

it('tells the person which keys answer the card from the buttons, not from a line of text', () => {
	const html = draw(bash('ls'))
	expect(html).not.toContain('Enter accepts. Esc rejects.')
	expect(html).toMatch(/title="Accept · Enter"/)
	expect(html).toMatch(/title="Reject · Esc"/)
	expect(html).not.toContain('stops this reply')
})

it('does not leave Enter on yes for a command or a file that deletes', () => {
	const risky = draw(bash('rm -rf build'))
	expect(risky).toMatch(/title="Reject · Enter or Esc"/)
	expect(risky).toMatch(
		/title="Accept · Ctrl\+Enter\. This one looks risky, so Enter rejects it\."/,
	)
	const removal = draw({
		id: 'r3',
		sessionId: 's',
		projectId: 'p',
		calls: [{ id: 'c3', name: 'delete_file', input: { path: 'a.ts' }, isDestructive: true }],
	})
	expect(removal).toMatch(/title="Reject · Enter or Esc"/)
})

it('offers the quiet conversation-wide yes only when the engine keeps it and the call is safe', () => {
	expect(draw(bash('ls'), undefined, undefined, true)).toMatch(
		/class="approval-split"[\s\S]*approval-split-label"[^>]*>Allow for this conversation<\/button><span class="approval-split-divider"[\s\S]*aria-label="More ways to allow"/,
	)
	// It is an outline beside Reject and Accept, never the filled one.
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

const screenMoment = (app = 'Editor'): PermissionView => ({
	id: 'r-screen',
	sessionId: 's',
	projectId: 'p',
	calls: [
		{
			id: 'screen-moment-1',
			name: 'screen_moment',
			input: { app },
			isDestructive: false,
			alwaysAsk: true,
		},
	],
})

it('draws the screen question as a one-time choice between allow now and not now', () => {
	// A conversation that holds a standing yes still gets the question, and is not offered another one.
	const html = draw(screenMoment(), '/work/site', 'Site', true)
	expect(html).toContain('aria-label="Screen question"')
	expect(html).toContain('Let Editor use your keyboard and mouse for a moment?')
	expect(html).toContain('Namzu needs your keyboard and mouse for a moment to use Editor.')
	expect(html).toMatch(/data-tone="accept"[^>]*>Allow this app</)
	expect(html).toMatch(/data-tone="reject"[^>]*>Not now</)
	expect(html).not.toContain('Allow for this conversation')
	expect(html).not.toContain('Tell Namzu what to do instead')
	expect(html).not.toContain('Details')
})

it('keeps a stray Enter from allowing the keyboard to be taken', () => {
	const html = draw(screenMoment())
	expect(html).toMatch(/title="Not now · Enter or Esc"/)
	expect(html).toMatch(/title="Allow this app · Ctrl\+Enter\. Enter says not now\."/)
	expect(html).not.toContain('Enter accepts')
})

it('names an application nobody could name', () => {
	expect(draw(screenMoment(' '))).toContain('Let an application use your keyboard and mouse')
})

it('wraps a long changed line by default so the end of it is on the card', () => {
	const tail = 'exec(process.env.PAYLOAD)'
	const html = draw(
		{
			id: 'r6',
			sessionId: 's',
			projectId: 'p',
			calls: [
				{
					id: 'c6',
					name: 'edit',
					input: { path: '/work/src/index.ts', old_string: 'a', new_string: 'b' },
					isDestructive: false,
					preview: {
						path: '/work/src/index.ts',
						before: 'const a = 1\n',
						after: `const a = '${'a'.repeat(190)}'; ${tail}\n`,
					},
				},
			],
		},
		'/work',
	)
	expect(html).toMatch(/class="approval-rows" data-wrap="true"/)
	expect(html).toContain(tail)
})

it('says so when a command in a later call of the request is the risky one', () => {
	const html = draw(
		{
			id: 'r7',
			sessionId: 's',
			projectId: 'p',
			calls: [
				{ id: 'a', name: 'bash', input: { command: 'ls' }, isDestructive: false },
				{ id: 'b', name: 'bash', input: { command: 'sudo rm -rf build' }, isDestructive: false },
			],
		},
		'/work',
	)
	expect(html).toContain('Runs with elevated rights.')
	expect(html).toContain('Looks like it deletes or overwrites files.')
})

it('draws one card with no surface of its own behind it and the preview as a framed block', () => {
	const html = draw(bash('pnpm test'))
	expect(html).toContain('class="approval-surface"')
	expect(html).toContain('class="approval-card"')
	expect(html).not.toContain('composer-banner')
	const css = readFileSync(new URL('./composer-approval.css', import.meta.url), 'utf8')
	const rule = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`)
		return css.slice(start, css.indexOf('}', start))
	}
	const card = rule('.approval-card')
	expect(card).toContain('border: 1px solid var(--border)')
	expect(card).toContain('border-radius: var(--radius-card)')
	expect(card).toContain('background: var(--card)')
	expect(card).not.toContain('box-shadow')
	const block = rule('.approval-card > .approval-box')
	expect(block).toContain('border: 1px solid var(--border)')
	expect(block).toContain('border-radius: var(--ask-preview-radius)')
	expect(block).toContain('background: var(--code-background)')
	expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
})
