import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { Transcript } from './transcript.js'

function started(at = 53000): ThreadState {
	return applyEvent(
		applyEvent(emptyThread(), {
			kind: 'prompt',
			sessionId: 'session',
			prompt: 'Check the workspace',
			at,
		}),
		{ kind: 'state', sessionId: 'session', running: true, queued: [] },
	)
}

function update(thread: ThreadState, value: AcpSessionUpdate, at?: number): ThreadState {
	return applyEvent(thread, {
		kind: 'update',
		sessionId: 'session',
		projectId: 'project',
		update: value,
		at,
	})
}

function render(thread: ThreadState): string {
	return renderToStaticMarkup(createElement(Transcript, { thread }))
}

function phaseLabels(html: string): string[] {
	return [...html.matchAll(/class="transcript-phase-text">([^<]*)</g)]
		.map((match) => match[1])
		.filter(Boolean)
}

function pendingCommand(thread = started()): ThreadState {
	return update(thread, {
		kind: 'tool_call',
		toolCallId: 'command',
		title: 'Read working directory',
		status: 'pending',
		view: { kind: 'terminal', command: 'pwd', output: 'Actual streamed output' },
	})
}

beforeEach(() => {
	vi.spyOn(Date, 'now').mockReturnValue(100000)
})
afterEach(() => {
	vi.restoreAllMocks()
})

describe('single live transcript status', () => {
	it('shows two earlier-message lookups once in the work rail and a distinct hosted web search', () => {
		let thread = started()
		for (const [id, query] of [
			['lookup-a', 'web_search'],
			['lookup-b', 'flexprice'],
		] as const) {
			thread = update(thread, {
				kind: 'tool_call',
				toolCallId: id,
				title: 'search_conversation',
				status: 'pending',
				view: { kind: 'generic', label: query },
			})
			thread = update(thread, {
				kind: 'tool_call',
				toolCallId: id,
				title: 'search_conversation',
				status: 'completed',
				view: { kind: 'terminal', output: '' },
			})
		}
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'provider-hosted-web-search:2:provider-id',
			title: 'Web search',
			status: 'completed',
			view: { kind: 'generic', label: 'Web search: H100 price · 10 sources' },
		})
		const live = render(thread)
		expect(live).toContain('Checked earlier messages')
		expect(live).toContain('Searched the web')
		expect(live).not.toContain('Actions completed')
		thread = update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, 100000)
		thread = applyEvent(thread, {
			kind: 'state',
			sessionId: 'session',
			running: false,
			queued: [],
		})
		expect(phaseLabels(render(thread))).toEqual(['Worked for 47s'])
	})

	it('offers message actions for settled assistant rows only', () => {
		const action = vi.fn((_message: ChatMessage, _key: string) =>
			createElement('button', { type: 'button' }, 'Listen'),
		)
		const draw = (thread: ThreadState) =>
			renderToStaticMarkup(createElement(Transcript, { thread, renderMessageAction: action }))
		const pending = update(started(), {
			kind: 'agent_message_chunk',
			messageId: 'answer',
			text: 'Draft answer',
		})
		expect(draw(pending)).not.toContain('Listen')
		expect(action).not.toHaveBeenCalled()
		const completed = update(pending, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			content: 'Draft answer',
			stopReason: 'end_turn',
		})
		expect(draw(completed)).not.toContain('Listen')
		const settled = update(completed, { kind: 'turn_ended', stopReason: 'end_turn' }, 100000)
		expect(draw(settled)).toContain('Listen')
		expect(action).toHaveBeenCalledOnce()
		expect(action.mock.calls[0]?.[0].role).toBe('assistant')
	})
	it('renders steering after prior commentary and action within the same turn', () => {
		let thread = started()
		thread = update(thread, {
			kind: 'agent_message_chunk',
			text: 'Prior commentary',
			phase: 'commentary',
			messageId: 'before',
		})
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'check',
			title: 'Check workspace',
			status: 'completed',
			view: { kind: 'terminal', command: 'pwd', output: 'workspace' },
		})
		thread = applyEvent(thread, {
			kind: 'live-input',
			sessionId: 'session',
			inputId: 'steer',
			prompt: 'Steer now',
			status: 'unknown',
		})
		thread = update(thread, {
			kind: 'agent_message_chunk',
			text: 'Following answer',
			messageId: 'after',
		})
		thread = applyEvent(thread, {
			kind: 'live-input',
			sessionId: 'session',
			inputId: 'steer',
			prompt: 'Steer now',
			status: 'delivered',
		})
		const html = render(thread)
		const prior = html.indexOf('Prior commentary')
		const action = html.indexOf('data-tool-call-id="check"')
		const steering = html.indexOf('Steer now')
		const following = html.indexOf('Following answer')
		expect(prior).toBeGreaterThan(-1)
		expect(action).toBeGreaterThan(prior)
		expect(steering).toBeGreaterThan(action)
		expect(following).toBeGreaterThan(steering)
		expect(html.match(/Steer now/g)).toHaveLength(1)
		expect(html.match(/data-transcript-turn="1"/g)).toHaveLength(1)
	})
	it('keeps one live phase and actual elapsed time while retaining the current work disclosure', () => {
		const thread = pendingCommand()
		const before = structuredClone(thread)
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Working', 'Working'])
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
		expect(html).toContain('aria-label="Working · 47s"')
		expect(html).toContain('aria-expanded="true"')
		expect(html).toContain('class="turn-activity-elapsed">47s</span>')
		expect(html).toContain('transcript-status-only')
		expect(html).toContain('Running pwd')
		expect(thread).toEqual(before)
	})

	it('keeps public reasoning and commentary as details without duplicating Thinking', () => {
		let thread = update(started(), {
			kind: 'agent_message_chunk',
			text: 'Inspecting the workspace',
			phase: 'commentary',
			messageId: 'commentary',
		})
		thread = update(thread, {
			kind: 'agent_thought_chunk',
			text: 'Comparing the public results',
			blockId: 'thought',
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Thinking', 'Thinking'])
		expect(html).toContain('Inspecting the workspace')
		expect(html).toContain('Comparing the public results')
		expect(html).toContain('data-transcript-phase="thinking"')
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
	})

	it('shows one waiting status while retaining the real pending action for review', () => {
		const thread = applyEvent(pendingCommand(), {
			kind: 'permission',
			request: { id: 'approval', sessionId: 'session', projectId: 'project', calls: [] },
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Waiting for your decision', 'Waiting for your decision'])
		expect(html).toContain('data-transcript-phase="waiting"')
		expect(html).toContain('Running pwd')
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
	})

	it('retains actual Thinking without an empty disclosure or invented public body for private reasoning', () => {
		const thread = update(started(), {
			kind: 'agent_thought_chunk',
			text: '',
			blockId: 'private-thought',
		})
		const before = structuredClone(thread)
		const html = render(thread)
		expect(thread.activeReasoningId).toBe('1:private-thought')
		expect(phaseLabels(html)).toEqual(['Thinking'])
		expect(html).not.toContain('turn-activity')
		expect(html).not.toContain('data-reasoning-id')
		expect(html).toContain('data-transcript-phase="thinking"')
		expect(thread).toEqual(before)
	})

	it('does not create details from an empty commentary event', () => {
		const thread = update(started(), {
			kind: 'agent_message_chunk',
			text: '',
			phase: 'commentary',
			messageId: 'empty-commentary',
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Working'])
		expect(html).not.toContain('turn-activity')
	})

	it('retains a completed historical work divider alongside the current single live status', () => {
		let thread = update(started(1000), {
			kind: 'agent_thought_chunk',
			text: 'Earlier public work',
		})
		thread = update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, 6000)
		thread = applyEvent(thread, {
			kind: 'prompt',
			sessionId: 'session',
			prompt: 'Next check',
			at: 53000,
		})
		thread = pendingCommand(thread)
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Worked for 5s', 'Working', 'Working'])
		expect(html).toContain('data-activity-turn="1"')
		expect(html).toContain('data-activity-turn="2"')
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
	})

	it.each([
		['end_turn', undefined, 'Worked for 47s'],
		['cancelled', undefined, 'Stopped · 47s'],
		['cancelled', 'paused', 'Paused · 47s'],
		['cancelled', 'structured_output_failed', 'Work incomplete · 47s'],
	] as const)('keeps truthful settled work labels for %s/%s', (stopReason, reason, label) => {
		let thread = update(pendingCommand(), { kind: 'turn_ended', stopReason, reason }, 100000)
		thread = applyEvent(thread, {
			kind: 'state',
			sessionId: 'session',
			running: false,
			queued: [],
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual([label])
		expect(html).not.toContain('Work details')
		expect(html).not.toContain('aria-live="polite"')
	})
})
