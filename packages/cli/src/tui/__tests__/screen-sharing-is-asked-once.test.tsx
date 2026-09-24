/**
 * The first look at the screen in a session asks once: the TUI's review
 * handler carries the session's consent record, the box says who receives
 * the screen and offers yes or no only, and a mode switch keeps the answer.
 */

import type { HITLDecisionRequest, ToolCallSummary } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'

import { PermissionOverlay, permissionAnswers } from '../PermissionOverlay.js'
import { type PermissionFn, type ScreenPolicy, makeResumeHandler } from '../agent.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'
import { renderToScreen } from './support/screen.js'

const screenshot: ToolCallSummary = {
	id: 'call_1',
	name: 'computer_use',
	input: { type: 'screenshot' },
	isDestructive: false,
}

function review(session: string, ...toolCalls: ToolCallSummary[]): HITLDecisionRequest {
	return {
		type: 'tool_review',
		sessionId: session as never,
		turnId: 't' as never,
		checkpointId: 'c' as never,
		toolCalls,
	}
}

it('asks once per session, and a mode switch does not ask again', async () => {
	const prompt = vi.fn<PermissionFn>(async () => ({ kind: 'approve' }))
	const screen: ScreenPolicy = {
		consent: { sessions: new Set() },
		capturesScreen: (name) => name === 'computer_use',
	}
	const readOnly = (name: string) => name === 'computer_use'
	const prompting = makeResumeHandler({ all: false }, prompt, 'prompt', readOnly, {}, screen)
	expect(await prompting(review('s', screenshot))).toEqual({ action: 'approve_tools' })
	expect(prompt).toHaveBeenCalledTimes(1)
	expect(prompt.mock.calls[0]?.[0].screenConsent).toBe(true)
	// The operator switches to plan mode: a new handler, the same record.
	const planning = makeResumeHandler({ all: false }, prompt, 'plan', readOnly, {}, screen)
	expect(await planning(review('s', { ...screenshot, id: 'call_2' }))).toEqual({
		action: 'approve_tools',
	})
	expect(prompt).toHaveBeenCalledTimes(1)
	// A new session is asked again.
	await planning(review('other', screenshot))
	expect(prompt).toHaveBeenCalledTimes(2)
})

it('offers yes or no, never "allow all tools", on the screen question', () => {
	expect(permissionAnswers([screenshot], { screenConsent: true })).toEqual([
		{ label: 'Yes, share my screen for this session', kind: 'approve' },
		{ label: 'No, and tell namzu what to do differently (esc)', kind: 'reject' },
	])
})

it('says who will see the screen', async () => {
	const review = buildPermissionReview([screenshot])
	if (!review.ok) throw new Error('fixture must fit the exact approval envelope')
	const screen = await renderToScreen(
		<PermissionOverlay
			toolCalls={[screenshot]}
			review={review.text}
			summary={buildPermissionSummary(review.text)}
			detailsOpen={false}
			columns={100}
			rows={30}
			screenConsent={{ provider: 'OpenAI (Codex)' }}
		/>,
		{ cols: 100, rows: 30 },
	)
	try {
		await screen.waitForRender()
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Share your screen')
		expect(visible).toContain('namzu will see your screen and send it to OpenAI (Codex) for this')
		expect(visible).toContain('Asked once per session.')
		expect(visible).toContain('Take a screenshot')
		expect(visible).toContain('Let namzu see your screen for the rest of this session?')
		expect(visible).toContain('❯ 1. Yes, share my screen for this session')
		expect(visible).toContain('2. No, and tell namzu what to do differently (esc)')
		expect(visible).not.toContain('allow all tools')
		expect(visible).toContain('y / n answer')
	} finally {
		await screen.unmount()
	}
})
