import { readFileSync } from 'node:fs'
import type { AcpSessionUpdate } from '@namzu/sdk'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ThreadState, applyEvent, emptyThread } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { Transcript } from './transcript.js'
import { workDisclosureKey } from './workspace-presentation.js'

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
		view: {
			kind: 'terminal',
			command: 'pwd',
			output: 'Actual streamed output',
		},
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
	it('keeps reply actions outside commentary, reasoning and tool details', () => {
		const action = vi.fn((message: ChatMessage) =>
			createElement('button', { type: 'button' }, `Copy ${message.text}`),
		)
		let thread = update(started(), {
			kind: 'agent_message',
			messageId: 'progress',
			status: 'completed',
			stopReason: 'tool_use',
			content: 'Checking the source.',
			textParts: [
				{
					id: 'progress-text',
					phase: 'commentary',
					text: 'Checking the source.',
				},
			],
		})
		thread = update(thread, {
			kind: 'agent_thought_chunk',
			blockId: 'thought',
			text: 'Compare the recorded details.',
		})
		thread = update(thread, {
			kind: 'tool_call',
			toolCallId: 'check',
			title: 'Read working directory',
			status: 'completed',
			view: { kind: 'terminal', command: 'pwd', output: 'workspace' },
		})
		thread = update(thread, {
			kind: 'agent_message',
			messageId: 'reply',
			status: 'completed',
			content: 'The source is ready.',
			textParts: [
				{
					id: 'reply-text',
					phase: 'final_answer',
					text: 'The source is ready.',
				},
			],
			stopReason: 'end_turn',
		})
		thread = update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, 100000)
		const html = renderToStaticMarkup(
			createElement(Transcript, { thread, renderMessageAction: action }),
		)
		expect(action).toHaveBeenCalledOnce()
		expect(action.mock.calls[0]?.[0].text).toBe('The source is ready.')
		expect(html).toContain('Copy The source is ready.')
		expect(html).not.toContain('Copy Checking the source.')
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
	it('assigns one timed header to the latest work segment after live steering', () => {
		let thread = update(started(), {
			kind: 'agent_message_chunk',
			text: 'First check',
			phase: 'commentary',
			messageId: 'first',
		})
		thread = applyEvent(thread, {
			kind: 'live-input',
			sessionId: 'session',
			inputId: 'steer',
			prompt: 'Check again',
			status: 'unknown',
		})
		thread = applyEvent(thread, {
			kind: 'live-input',
			sessionId: 'session',
			inputId: 'steer',
			prompt: 'Check again',
			status: 'delivered',
		})
		thread = update(thread, {
			kind: 'agent_message_chunk',
			text: 'Second check',
			phase: 'commentary',
			messageId: 'second',
		})
		const live = render(thread)
		expect(phaseLabels(live)).toEqual(['Earlier work', 'Working', 'Working'])
		expect(live.match(/class="turn-activity-elapsed"/g)).toHaveLength(1)
		expect(live).toContain('aria-label="Working for 47s"')
		expect(live.indexOf('First check')).toBeLessThan(live.indexOf('Check again'))
		expect(live.indexOf('Check again')).toBeLessThan(live.indexOf('Second check'))
		thread = update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, 100000)
		thread = applyEvent(thread, {
			kind: 'state',
			sessionId: 'session',
			running: false,
			queued: [],
		})
		expect(phaseLabels(render(thread))).toEqual(['Earlier work', 'Worked for 47s'])
	})
	it('keeps a neutral timed work header and no status line while a tool runs', () => {
		const thread = pendingCommand()
		const before = structuredClone(thread)
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Working', 'Working'])
		// The running row is the live element, so nothing is announced.
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toBeNull()
		expect(html).toContain('aria-label="Working for 47s"')
		expect(html).toContain('aria-expanded="true"')
		expect(html).toContain('class="turn-activity-elapsed">for 47s</span>')
		expect(html).toContain('transcript-status-only')
		expect(html).not.toContain('class="working-elapsed"')
		expect(html).toContain('Running command')
		expect(thread).toEqual(before)
	})

	it('puts one status line after the newest entry and never repeats what the block shows', () => {
		let thread = update(started(), {
			kind: 'agent_message_chunk',
			text: 'Inspecting the workspace',
			phase: 'commentary',
			messageId: 'commentary',
		})
		thread = update(thread, {
			kind: 'agent_thought_chunk',
			text: '**Comparing the public results**\n\nThe rows differ.',
			blockId: 'thought',
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Working', 'Thinking'])
		// The headline is the status line, after the narration; its own row stands down.
		expect(html.match(/Comparing the public results/g)).toHaveLength(2) // hidden announcement + visible text
		expect(html).toContain('stage-text">Comparing the public results<')
		expect(html).not.toContain('data-reasoning-id')
		expect(html).not.toContain('The rows differ.')
		expect(html.indexOf('Inspecting the workspace')).toBeLessThan(html.indexOf('stage-line'))
		expect(html).toContain('aria-label="Working for 47s"')
		expect(html).toContain('data-transcript-phase="thinking"')
		expect(html).toContain('working  transcript-status-only')
		expect(html).not.toContain('class="working-elapsed"')
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
	})

	it('draws the reasoning row in place once something newer arrives, with no status line', () => {
		let thread = update(started(), {
			kind: 'agent_thought_chunk',
			text: '**Planning the change**\n\nThe notes ask for roomier rows.',
			blockId: 'thought',
		})
		thread = pendingCommand(thread)
		const html = render(thread)
		expect(html).toContain('data-reasoning-id')
		expect(html).toContain('The notes ask for roomier rows.')
		expect(html).not.toContain('stage-line')
		expect(html.match(/Planning the change/g)).toHaveLength(1)
	})

	it('shows the narration being written once, shimmering, and no status line beside it', () => {
		const thread = update(started(), {
			kind: 'agent_message_chunk',
			text: 'I will read the notes, then update the styles.',
			phase: 'commentary',
			messageId: 'commentary',
		})
		const html = render(thread)
		expect(html.match(/I will read the notes, then update the styles\./g)).toHaveLength(1)
		expect(html).toContain('data-streaming=""')
		expect(html).not.toContain('stage-line')
	})

	it('says Thinking in a gap after an action finished, announced once', () => {
		const thread = update(pendingCommand(), {
			kind: 'tool_call',
			toolCallId: 'command',
			title: 'Read working directory',
			status: 'completed',
			view: { kind: 'terminal', command: 'pwd', output: '/work' },
		})
		const html = render(thread)
		expect(html).toContain('stage-text">Thinking<')
		expect(html).toContain('data-stage-source="gap"')
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toHaveLength(1)
		expect(html).not.toContain('data-streaming')
	})

	it('keeps motion off for reduced-motion readers', () => {
		const css = readFileSync(new URL('./transcript-motion.css', import.meta.url), 'utf8')
		const reduced = css.slice(
			css.indexOf('@media (prefers-reduced-motion: reduce) {\n\t.normal-transcript .stage-text'),
		)
		expect(reduced).toContain('.stage-text')
		expect(reduced).toContain('[data-streaming] .message-text > :last-child')
		expect(reduced.slice(0, reduced.indexOf('\n}\n') + 3)).toContain('animation: none')
	})

	it('shows no stage line once the answer has started', () => {
		const thread = update(
			update(started(), {
				kind: 'agent_message_chunk',
				text: 'Looking around.',
				phase: 'commentary',
				messageId: 'commentary',
			}),
			{ kind: 'agent_message_chunk', text: 'Here is the answer.', messageId: 'answer' },
		)
		expect(render(thread)).not.toContain('stage-line')
	})

	it('shows real waiting separately from the timed work header and pending action', () => {
		const thread = applyEvent(pendingCommand(), {
			kind: 'permission',
			request: {
				id: 'approval',
				sessionId: 'session',
				projectId: 'project',
				calls: [],
			},
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Working', 'Waiting for your decision'])
		expect(html).toContain('data-transcript-phase="waiting"')
		expect(html).toContain('data-stage-source="waiting"')
		expect(html).not.toContain('class="working-elapsed"')
		expect(html).toContain('Running command')
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
		expect(html).toContain('class="working-elapsed"')
		expect(thread).toEqual(before)
	})

	it('keeps the settled work disclosure collapsed before its final answer', () => {
		let thread = update(started(), {
			kind: 'agent_message_chunk',
			text: 'Checking the evidence',
			phase: 'commentary',
			messageId: 'update',
		})
		thread = update(thread, {
			kind: 'agent_message',
			status: 'completed',
			messageId: 'answer',
			content: 'Final answer is ready',
			stopReason: 'end_turn',
		})
		thread = update(thread, { kind: 'turn_ended', stopReason: 'end_turn' }, 100000)
		thread = applyEvent(thread, {
			kind: 'state',
			sessionId: 'session',
			running: false,
			queued: [],
		})
		const html = render(thread)
		expect(phaseLabels(html)).toEqual(['Worked for 47s'])
		expect(html).toContain('aria-expanded="false"')
		expect(html.indexOf('Checking the evidence')).toBeGreaterThan(
			html.indexOf('data-slot="collapsible-panel"'),
		)
		expect(html.indexOf('Final answer is ready')).toBeGreaterThan(
			html.indexOf('Checking the evidence'),
		)
	})
	it('restores only an explicit disclosure choice and preserves the live/settled defaults', () => {
		const live = update(started(), {
			kind: 'agent_message_chunk',
			text: 'Checking now',
			phase: 'commentary',
			messageId: 'commentary',
		})
		const key = workDisclosureKey(1, 'message-1')
		expect(key).toBeDefined()
		const draw = (thread: ThreadState, choice?: boolean) =>
			renderToStaticMarkup(
				createElement(Transcript, {
					thread,
					workDisclosures: choice === undefined ? {} : { [key!]: choice },
					onWorkDisclosureChange: vi.fn(),
				}),
			)
		expect(draw(live)).toContain('aria-expanded="true"')
		expect(draw(live, false)).toContain('aria-expanded="false"')
		let settled = update(live, { kind: 'turn_ended', stopReason: 'end_turn' }, 100000)
		settled = applyEvent(settled, {
			kind: 'state',
			sessionId: 'session',
			running: false,
			queued: [],
		})
		expect(draw(settled)).toContain('aria-expanded="false"')
		expect(draw(settled, true)).toContain('aria-expanded="true"')
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
		expect(html.match(/<output\b[^>]*aria-live="polite"/g)).toBeNull()
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

describe('sent attachments and date separators', () => {
	const image = (preview?: string) => ({
		id: 'img',
		name: 'shot.png',
		kind: 'image' as const,
		size: 2048,
		mediaType: 'image/png',
		...(preview ? { preview } : {}),
	})
	const withMessages = (messages: ChatMessage[]): ThreadState => {
		const thread = emptyThread()
		thread.messages = messages
		thread.timeline = messages.map((_, index) => ({ kind: 'message', index, turn: index + 1 }))
		thread.turn = messages.length
		return thread
	}
	it('renders attachments above the bubble and no bubble for an attachment-only message', () => {
		const html = render(
			withMessages([
				{ role: 'user', text: 'Look at this', attachments: [image('data:image/png;base64,AA==')] },
				{ role: 'user', text: '', attachments: [image('data:image/png;base64,AA==')] },
			]),
		)
		const [first, second] = html.split('data-message-role="user"').slice(1)
		expect(first?.indexOf('attachment-cards')).toBeLessThan(first?.indexOf('message-text') ?? 0)
		expect(second).toContain('attachment-cards')
		expect(second).not.toContain('message-text')
	})
	it('holds a spinner box while delivery is pending and keeps Preview unavailable afterwards', () => {
		const pending = render(
			withMessages([{ role: 'user', text: '', status: 'pending', attachments: [image()] }]),
		)
		expect(pending).toContain('data-attachment-state="pending"')
		expect(pending).toContain('Loading preview')
		const evicted = render(withMessages([{ role: 'user', text: 'x', attachments: [image()] }]))
		expect(evicted).toContain('data-attachment-state="unavailable"')
		expect(evicted).toContain('Preview unavailable')
	})
	it('puts a date separator before the first known time and after a long gap, not for unknown times', () => {
		const known = (hour: number) => ({
			at: new Date(2026, 7, 6, hour).getTime(),
			source: 'host' as const,
		})
		const html = render(
			withMessages([
				{ role: 'user', text: 'a' },
				{ role: 'user', text: 'b', time: known(9) },
				{ role: 'user', text: 'c', time: known(10) },
				{ role: 'user', text: 'd' },
				{ role: 'user', text: 'e', time: known(18) },
			]),
		)
		expect(html.match(/transcript-date-separator/g)).toHaveLength(2)
		expect(html.indexOf('transcript-date-separator')).toBeGreaterThan(html.indexOf('>a<'))
		expect(html.indexOf('transcript-date-separator')).toBeLessThan(html.indexOf('>b<'))
		expect(
			renderToStaticMarkup(
				createElement(Transcript, {
					thread: withMessages([{ role: 'user', text: 'b', time: known(9) }]),
					dateSeparators: false,
				}),
			),
		).not.toContain('transcript-date-separator')
	})
})
