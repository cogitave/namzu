/** The approval box when it asks about one call at a time: the count, who asks, the typed reason. */

import { describe, expect, it } from 'vitest'

import { PermissionOverlay, permissionQuestion, permissionTitle } from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

const shell: PermissionToolCall = {
	id: 'c',
	name: 'bash',
	input: { command: 'git status' },
	isDestructive: false,
}

async function rows(
	props: Partial<React.ComponentProps<typeof PermissionOverlay>>,
	columns = 100,
	toolCalls: readonly PermissionToolCall[] = [shell],
): Promise<string[]> {
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must be representable')
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={toolCalls}
			review={review.text}
			summary={buildPermissionSummary(review.text)}
			detailsOpen={false}
			columns={columns}
			rows={30}
			mode="prompt"
			{...props}
		/>,
		{ cols: columns, rows: 30 },
	)
	try {
		await screen.waitForRender()
		return [...screen.viewport()]
	} finally {
		await screen.unmount()
	}
}

describe('the count on the title row', () => {
	it('shows "k of N" dim and right-aligned when two or more questions are open', async () => {
		const viewport = await rows({ count: { position: 2, total: 3 } })
		const title = viewport.find((row) => row.includes('Bash command'))
		expect(title).toBeDefined()
		expect(title).toMatch(/2 of 3\s*│$/)
		expect(viewport.join('\n')).not.toContain('more awaiting approval')
	})

	it('shows nothing when no count is given', async () => {
		const viewport = await rows({})
		expect(viewport.join('\n')).not.toMatch(/\d of \d/)
	})

	it('drops the count, without a fallback, when the title row has no room for it', async () => {
		const viewport = await rows(
			{ count: { position: 1, total: 2 }, from: 'from the Reviewer agent' },
			34,
		)
		const title = viewport.find((row) => row.includes('Bash command'))
		expect(title).toBeDefined()
		expect(title).not.toContain('1 of 2')
		expect(viewport.join('\n')).not.toContain('awaiting')
	})

	it('names the agent on the title row in plain words', async () => {
		const viewport = await rows({ from: 'from the Reviewer agent' })
		const title = viewport.find((row) => row.includes('Bash command'))
		expect(title).toContain('from the Reviewer agent')
	})
})

describe('refusing', () => {
	it('says a plain No stops here when it ends the turn, and offers Tab to say why on that row', async () => {
		const viewport = await rows({ endsTurn: true, choice: 1 })
		const text = viewport.join('\n')
		expect(text).toContain('No, and stop here (esc)')
		expect(text).toContain('tab say why')
	})

	it('does not offer Tab while the cursor is on Yes', async () => {
		const viewport = await rows({ endsTurn: true, choice: 0 })
		expect(viewport.join('\n')).not.toContain('tab say why')
	})

	it('replaces the answers with the typed reason while one is being written', async () => {
		const viewport = await rows({ reason: 'use the other file' })
		const text = viewport.join('\n')
		expect(text).toContain('Tell Namzu what to do differently')
		expect(text).toContain('use the other file')
		expect(text).toContain('enter send')
		expect(text).toContain('esc back')
		expect(text).not.toContain('1. Yes')
	})

	it('offers shift+tab where the answer that accepts edits is offered', async () => {
		const edit: PermissionToolCall = {
			id: 'e',
			name: 'edit',
			input: { path: 'a.ts', old_string: 'a', new_string: 'b' },
			isDestructive: false,
		}
		const viewport = await rows({ mode: 'prompt' }, 140, [edit])
		expect(viewport.join('\n')).toContain('shift+tab accept edits')
	})
})

describe('a connector tool', () => {
	const slack: PermissionToolCall = {
		id: 's',
		name: 'mcp__slack__post',
		input: { text: 'hi' },
		isDestructive: false,
	}

	it('is named by its server and tool in the title and the question', () => {
		expect(permissionTitle([slack])).toBe('slack · post')
		expect(permissionQuestion([slack])).toBe('Do you want to run slack · post?')
	})

	it('never shows the wire name on the screen', async () => {
		const viewport = await rows({}, 100, [slack])
		const text = viewport.join('\n')
		expect(text).toContain('slack · post')
		expect(text.split('\n').filter((row) => row.includes('Do you want to run'))).toEqual([
			expect.stringContaining('slack · post'),
		])
		expect(
			text.split('\n').find((row) => row.includes('slack · post') && row.includes('mcp__')),
		).toBeUndefined()
	})
})
