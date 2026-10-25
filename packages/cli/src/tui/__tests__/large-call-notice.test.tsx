/** A call too large to show in full: a plain notice and a one-time yes only. */

import { afterEach, expect, it, vi } from 'vitest'

import { PermissionOverlay } from '../PermissionOverlay.js'
import {
	MAX_REVIEW_VALUE_CHARS,
	buildPermissionReview,
	buildPermissionSummary,
} from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

afterEach(() => {
	vi.unstubAllEnvs()
})

function overlayFor(calls: ReadonlyArray<{ name: string; input: unknown }>) {
	const toolCalls = calls.map((call, index) => ({
		id: `c${index}`,
		name: call.name,
		input: call.input,
		isDestructive: true,
	}))
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must be representable')
	return (
		<PermissionOverlay
			toolCalls={toolCalls}
			review={review.text}
			summary={buildPermissionSummary(review.text)}
			detailsOpen={false}
			columns={100}
			rows={30}
			mode="prompt"
			commandArguments={new Map([['bash', 'command']])}
			withheld={review.withheld}
		/>
	)
}

it('shows the notice and exactly two answers for a call past the limit', async () => {
	vi.stubEnv('COLORTERM', 'truecolor')
	const screen = await renderToScreen(
		overlayFor([{ name: 'bash', input: { command: 'x'.repeat(MAX_REVIEW_VALUE_CHARS + 5) } }]),
		{ cols: 100, rows: 30 },
	)
	try {
		await screen.waitForRender()
		const visible = screen.viewport().join('\n')
		expect(visible).toContain(
			'Too large to show in full. Approving runs it once and is not remembered.',
		)
		expect(visible).toContain('❯ 1. Yes')
		expect(visible).toContain('2. No, and tell Namzu what to do differently')
		expect(visible).not.toContain('3. ')
		expect(visible).not.toContain("don't ask again")
		expect(visible).not.toContain('accept edits')
	} finally {
		await screen.unmount()
	}
})

it('names the call that is too large inside a batch, and leaves the others readable', async () => {
	const screen = await renderToScreen(
		overlayFor([
			{ name: 'bash', input: { command: 'git status' } },
			{
				name: 'write',
				input: { path: '/tmp/big', content: 'y'.repeat(MAX_REVIEW_VALUE_CHARS + 1) },
			},
		]),
		{ cols: 100, rows: 40 },
	)
	try {
		await screen.waitForRender()
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('2. write: Too large to show in full.')
		expect(visible).not.toContain('1. bash: Too large')
		expect(visible).toContain('git status')
	} finally {
		await screen.unmount()
	}
})

it('offers the wider answers again when nothing is withheld', async () => {
	const toolCalls = [
		{ id: 'c', name: 'bash', input: { command: 'npm test' }, isDestructive: false },
	]
	const review = buildPermissionReview(toolCalls)
	if (!review.ok) throw new Error('fixture must be representable')
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={toolCalls}
			review={review.text}
			summary={buildPermissionSummary(review.text)}
			detailsOpen={false}
			columns={100}
			rows={30}
			mode="prompt"
			commandArguments={new Map([['bash', 'command']])}
		/>,
		{ cols: 100, rows: 30 },
	)
	try {
		await screen.waitForRender()
		const visible = screen.viewport().join('\n')
		expect(visible).not.toContain('Too large to show')
		expect(visible).toContain("don't ask again")
	} finally {
		await screen.unmount()
	}
})

it('shows a 20 kB write bounded, with the rest one page key away and no notice', async () => {
	const content = `${Array.from({ length: 500 }, (_, i) => `line ${i} ${'w'.repeat(40)}`).join('\n')}\nLAST_LINE`
	expect(content.length).toBeGreaterThan(20_000)
	const screen = await renderToScreen(
		overlayFor([{ name: 'write', input: { path: '/tmp/f', content } }]),
		{
			cols: 100,
			rows: 30,
		},
	)
	try {
		await screen.waitForRender()
		const first = screen.viewport().join('\n')
		expect(first).not.toContain('Too large to show')
		expect(first).toMatch(/rows \d+-\d+\/\d+ · PgUp\/PgDn/u)
		expect(first).not.toContain('LAST_LINE')
		expect(first).toContain('Write · 501 lines')
	} finally {
		await screen.unmount()
	}
})
