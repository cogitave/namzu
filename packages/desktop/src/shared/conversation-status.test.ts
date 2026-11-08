import { expect, it } from 'vitest'
import { type ConversationGlyphFacts, conversationGlyph } from './conversation-status.js'

const quiet: ConversationGlyphFacts = {
	permissions: [],
	running: false,
	error: false,
	unread: false,
}
const approval = { calls: [{ name: 'write_file' }] }
const question = { calls: [{ name: 'ask_user_question' }] }

it('has no mark for a conversation with nothing to say', () => {
	expect(conversationGlyph(quiet)).toEqual({ kind: 'idle', label: '' })
})

it('derives each mark from facts and gives it words', () => {
	expect(conversationGlyph({ ...quiet, running: true })).toEqual({
		kind: 'running',
		label: 'Running',
	})
	expect(conversationGlyph({ ...quiet, error: true })).toEqual({
		kind: 'error',
		label: 'Needs attention',
	})
	expect(conversationGlyph({ ...quiet, unread: true })).toEqual({
		kind: 'unread',
		label: 'New reply',
	})
	expect(conversationGlyph({ ...quiet, permissions: [approval] })).toEqual({
		kind: 'permission',
		label: 'Approval needed',
	})
	expect(conversationGlyph({ ...quiet, permissions: [question] })).toEqual({
		kind: 'question',
		label: 'Question waiting',
	})
})

it('tells a question from an approval even when both wait', () => {
	expect(conversationGlyph({ ...quiet, permissions: [approval, question] }).kind).toBe('question')
})

it('shows one mark, the one that needs the person most', () => {
	const all = { permissions: [approval], running: true, error: true, unread: true }
	expect(conversationGlyph(all).kind).toBe('permission')
	expect(conversationGlyph({ ...all, permissions: [] }).kind).toBe('running')
	expect(conversationGlyph({ ...all, permissions: [], running: false }).kind).toBe('error')
	expect(conversationGlyph({ ...all, permissions: [], running: false, error: false }).kind).toBe(
		'unread',
	)
})

it('never uses text the model wrote', () => {
	// The facts are flags and tool names; a tool's input, which is model text, is not even a field.
	const facts: ConversationGlyphFacts = {
		...quiet,
		permissions: [{ calls: [{ name: 'write_file', ...{ input: 'ask_user_question' } }] }],
	}
	expect(conversationGlyph(facts).kind).toBe('permission')
})
