import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
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
	it('keeps one live phase and actual elapsed time while retaining the current work disclosure', () => {
		const thread = pendingCommand()
		const before = structuredClone(thread)
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Work details', 'Working'])
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
		expect(html).toContain('aria-label="Work details"')
		expect(html).toContain('aria-expanded="true"')
		expect(html).toContain('class="working-elapsed" aria-hidden="true">47s</span>')
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
		expect(phaseLabels(html)).toEqual(['Work details', 'Thinking'])
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
		expect(phaseLabels(html)).toEqual(['Work details', 'Waiting for your decision'])
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
		expect(phaseLabels(html)).toEqual(['Worked for 5s', 'Work details', 'Working'])
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
