/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `messageToA2A(msg)` role mapping: user → user; assistant / system /
 *     tool → agent. Any other MessageRole triggers the exhaustive-check
 *     throw (unreachable via types).
 *   - Non-empty `content` produces one text part.
 *   - Assistant with `toolCalls`: one data part per tool call with
 *     mimeType `application/x-namzu-tool-call` and fields
 *     `{toolCallId, name, arguments}`.
 *   - If the message would produce zero parts (null content, no tool
 *     calls), a fallback empty-text part is added.
 *   - `extractTextFromA2AMessage(msg)` joins text parts with '\n' and
 *     ignores non-text parts entirely.
 *   - `a2aMessageToInput` is a pure alias for `extractTextFromA2AMessage`.
 *   - Only SDK → A2A direction is covered (design.md §2.7: no reverse
 *     mapper exists).
 */

import { describe, expect, it } from 'vitest'

import type { A2AMessage } from '../../types/a2a/index.js'
import type {
	AssistantMessage,
	SystemMessage,
	ToolMessage,
	UserMessage,
} from '../../types/message/index.js'

import { a2aMessageToInput, extractTextFromA2AMessage, messageToA2A } from './message.js'

describe('messageToA2A', () => {
	it('maps user role to user', () => {
		const msg: UserMessage = { role: 'user', content: 'hi' }
		expect(messageToA2A(msg).role).toBe('user')
	})

	it.each([['system'], ['assistant'], ['tool']])('maps %s role to agent', (role) => {
		const msg = { role, content: 'x', ...(role === 'tool' && { toolCallId: 'c' }) } as
			| SystemMessage
			| AssistantMessage
			| ToolMessage
		expect(messageToA2A(msg).role).toBe('agent')
	})

	it('emits a single text part for content-only messages', () => {
		const msg: UserMessage = { role: 'user', content: 'hello' }
		const a2a = messageToA2A(msg)
		expect(a2a.parts).toEqual([{ kind: 'text', text: 'hello' }])
	})

	it('emits text + data parts when the assistant has tool calls', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: 'let me check',
			toolCalls: [
				{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{"p":"/a"}' } },
				{ id: 'tc2', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
			],
		}
		const a2a = messageToA2A(msg)
		expect(a2a.parts).toEqual([
			{ kind: 'text', text: 'let me check' },
			{
				kind: 'data',
				data: { toolCallId: 'tc1', name: 'read_file', arguments: '{"p":"/a"}' },
				mimeType: 'application/x-namzu-tool-call',
			},
			{
				kind: 'data',
				data: { toolCallId: 'tc2', name: 'list_dir', arguments: '{}' },
				mimeType: 'application/x-namzu-tool-call',
			},
		])
	})

	it('emits ONLY data parts (no text part) when content is null and tool calls exist', () => {
		const msg: AssistantMessage = {
			role: 'assistant',
			content: null,
			toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'x', arguments: '{}' } }],
		}
		const a2a = messageToA2A(msg)
		expect(a2a.parts.some((p) => p.kind === 'text')).toBe(false)
		expect(a2a.parts.some((p) => p.kind === 'data')).toBe(true)
	})

	it('fallbacks to an empty text part when content is null and no tool calls', () => {
		const msg: AssistantMessage = { role: 'assistant', content: null }
		expect(messageToA2A(msg).parts).toEqual([{ kind: 'text', text: '' }])
	})
})

describe('extractTextFromA2AMessage', () => {
	it('joins every text part with a newline', () => {
		const msg: A2AMessage = {
			role: 'user',
			parts: [
				{ kind: 'text', text: 'line 1' },
				{ kind: 'text', text: 'line 2' },
			],
		}
		expect(extractTextFromA2AMessage(msg)).toBe('line 1\nline 2')
	})

	it('ignores non-text parts', () => {
		const msg: A2AMessage = {
			role: 'agent',
			parts: [
				{ kind: 'text', text: 'hello' },
				{ kind: 'data', data: { foo: 1 }, mimeType: 'application/json' },
			],
		}
		expect(extractTextFromA2AMessage(msg)).toBe('hello')
	})

	it('returns empty string when there are no text parts', () => {
		const msg: A2AMessage = {
			role: 'agent',
			parts: [{ kind: 'data', data: {}, mimeType: 'x' }],
		}
		expect(extractTextFromA2AMessage(msg)).toBe('')
	})
})

describe('a2aMessageToInput', () => {
	it('behaves identically to extractTextFromA2AMessage', () => {
		const msg: A2AMessage = {
			role: 'user',
			parts: [
				{ kind: 'text', text: 'a' },
				{ kind: 'text', text: 'b' },
				{ kind: 'data', data: {}, mimeType: 'x' },
			],
		}
		expect(a2aMessageToInput(msg)).toBe(extractTextFromA2AMessage(msg))
	})
})
