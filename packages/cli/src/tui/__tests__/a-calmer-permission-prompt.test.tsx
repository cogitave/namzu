/**
 * The permission prompt names files relative to the working folder, leaves a leading
 * `cd <that folder> &&` out of a command (and out of the waiting row of the call), keeps a cd that
 * goes elsewhere, and says one thing once while a call waits for its answer.
 */

import { render } from 'ink-testing-library'
import { expect, it } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'
import { PermissionOverlay, permissionTitle } from '../PermissionOverlay.js'
import { type PermissionToolCall, toAgentEvent } from '../agent.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { queuedToolRow } from '../queued-calls.js'
import { renderToScreen } from './support/screen.js'

import type { ToolPresenter } from '@namzu/sdk'

const CWD = '/work/app'

/** A shell call is a terminal view, as the shell tool's own presenter makes it. */
const presenter: ToolPresenter = {
	presentCall: (name, input) =>
		name === 'bash'
			? { kind: 'terminal', command: (input as { command: string }).command, output: '' }
			: { kind: 'generic', label: name },
	presentResult: (name) => ({ kind: 'generic', label: name }),
}

function summaryOf(calls: readonly PermissionToolCall[], cwd: string | undefined = CWD) {
	const review = buildPermissionReview(calls)
	if (!review.ok) throw new Error('fixture must be representable')
	return {
		review: review.text,
		summary: buildPermissionSummary(review.text, { ...(cwd ? { cwd } : {}) }),
	}
}

const edit: PermissionToolCall = {
	id: 'e',
	name: 'edit',
	input: { path: '/work/app/src/summary.js', old_string: 'a', new_string: 'b' },
	isDestructive: false,
}
const shell = (command: string): PermissionToolCall => ({
	id: 's',
	name: 'bash',
	input: { command },
	isDestructive: false,
})

it('titles an edit with the file relative to the working folder', () => {
	expect(permissionTitle([edit], CWD)).toBe('Edit file src/summary.js')
	expect(permissionTitle([edit])).toBe('Edit file /work/app/src/summary.js')
	// outside the folder the path is not made into ../..
	expect(
		permissionTitle(
			[{ ...edit, input: { ...(edit.input as object), path: '/elsewhere/x.js' } }],
			CWD,
		),
	).toBe('Edit file /elsewhere/x.js')
})

it('names the file in the diff relative to the working folder too', () => {
	const { summary } = summaryOf([edit])
	expect(summary.text).toContain('src/summary.js')
	expect(summary.text).not.toContain('/work/app/src/summary.js')
})

it('leaves a leading cd to the working folder out of the command the box shows', () => {
	expect(summaryOf([shell('cd /work/app && npm test')]).summary.text).toContain('$ npm test')
	expect(summaryOf([shell('cd /work/app && npm test')]).summary.text).not.toContain('cd /work/app')
	// the exact input the person can open with `d` is untouched
	expect(summaryOf([shell('cd /work/app && npm test')]).review).toContain(
		'cd /work/app && npm test',
	)
})

it('keeps a cd that goes elsewhere', () => {
	expect(summaryOf([shell('cd /work/other && npm test')]).summary.text).toContain(
		'$ cd /work/other && npm test',
	)
})

it('draws the box with the relative title and the bare command', async () => {
	const call = shell('cd /work/app && npm test')
	const { review, summary } = summaryOf([call])
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={[call]}
			review={review}
			summary={summary}
			detailsOpen={false}
			columns={90}
			rows={24}
			cwd={CWD}
		/>,
		{ cols: 90, rows: 24 },
	)
	try {
		await screen.waitForRender()
		const text = screen.viewport().join('\n')
		expect(text).toContain('$ npm test')
		expect(text).not.toContain('/work/app')
	} finally {
		await screen.unmount()
	}
})

it('leaves the cd out of the waiting row of the call as well, and keeps one that goes elsewhere', () => {
	const row = (command: string) =>
		queuedToolRow(shell(command), 't', presenter, CWD, 0)?.label ?? ''
	expect(row('cd /work/app && npm test')).toContain('npm test')
	expect(row('cd /work/app && npm test')).not.toContain('cd /work/app')
	expect(row('cd /work/other && npm test')).toContain('cd /work/other && npm test')
	const started = toAgentEvent(
		{
			type: 'tool_executing',
			toolUseId: 'x',
			toolName: 'bash',
			input: { command: 'cd /work/app && ls' },
		} as unknown as Parameters<typeof toAgentEvent>[0],
		presenter,
		undefined,
		CWD,
	)
	expect(started?.kind === 'tool-start' ? started.command : undefined).toBe('ls')
})

it('says one waiting row while a call waits for its answer, not two', () => {
	const queued = queuedToolRow(shell('npm test'), 't', presenter, CWD, 0)
	if (!queued) throw new Error('fixture')
	const view = render(
		<LiveActivity
			activeTools={[queued]}
			working
			animate={false}
			waitingForYou
			waitingFor="approval"
		/>,
	)
	try {
		const frame = view.lastFrame() ?? ''
		expect(frame).toContain('npm test')
		expect(frame).toContain('Waiting…')
		expect(frame).not.toContain('Waiting for your approval')
		expect(frame).not.toContain('the question below')
	} finally {
		view.unmount()
	}
})

it('still says it is waiting when there is no call row to say it', () => {
	const view = render(
		<LiveActivity activeTools={[]} working animate={false} waitingForYou waitingFor="approval" />,
	)
	try {
		expect(view.lastFrame() ?? '').toContain('Waiting for your approval')
	} finally {
		view.unmount()
	}
})
