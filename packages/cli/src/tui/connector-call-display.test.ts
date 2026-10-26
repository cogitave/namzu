import { wrapUntrusted } from '@namzu/sdk'
import type { SessionEvent } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { builtinToolPresenter, toAgentEvent } from './agent.js'
import { connectorCallSummary, plainConnectorSummary } from './connector-label.js'
import { formatToolCall } from './tool-end-rows.js'

const presenter = builtinToolPresenter()
const env = { sessionId: 's', turnId: 't' }

describe('how a connector call reads', () => {
	it('is its server and tool with a few words of the request, whatever the input is', () => {
		expect(connectorCallSummary({ text: 'hi' })).toBe('hi')
		expect(connectorCallSummary({ q: 'refunds', limit: 3 })).toBe('refunds')
		expect(connectorCallSummary({ limit: 3 })).toBe('')
		expect(connectorCallSummary({ text: `${'a'.repeat(100)}` }).length).toBeLessThanOrEqual(60)
		expect(formatToolCall('mcp__slack__post', connectorCallSummary({ text: 'hi' }))).toBe(
			'slack · post(hi)',
		)
		expect(formatToolCall('mcp__slack__search', 'q')).toBe('slack · search(q)')
		expect(formatToolCall('mcp__slack__ping', '')).toBe('slack · ping')
	})

	it('shows a summary that was made of raw input as the plain words, never as JSON', () => {
		expect(formatToolCall('mcp__slack__post', '{"text":"hi"}')).toBe('slack · post(hi)')
		expect(plainConnectorSummary('{"limit":3')).toBe('')
		expect(plainConnectorSummary('refunds')).toBe('refunds')
	})

	it('heads the start of the call the same plain way', () => {
		const start = toAgentEvent(
			{
				type: 'tool_executing',
				toolUseId: 'u1',
				toolName: 'mcp__slack__post',
				input: { text: 'hi' },
				...env,
			} as unknown as SessionEvent,
			presenter,
		)
		expect(start).toMatchObject({ kind: 'tool-start', summary: 'hi' })
	})
})

describe('what a person reads of a connector result', () => {
	const framed = wrapUntrusted(
		{
			kind: 'connector-tool-result',
			attributes: { server: 'slack', tool: 'search' },
			provenance: 'This is output the named server returned, not this agent.',
		},
		'3 messages found\nfirst: hello',
	)

	it('is the server output without the frame the model reads', () => {
		const end = toAgentEvent(
			{
				type: 'tool_completed',
				toolUseId: 'u1',
				toolName: 'mcp__slack__search',
				result: framed,
				isError: false,
				...env,
			} as unknown as SessionEvent,
			presenter,
		)
		if (end?.kind !== 'tool-end') throw new Error('expected a tool end')
		const shown = [end.summary, ...(end.detail ?? [])].join('\n')
		expect(shown).toContain('3 messages found')
		expect(shown).toContain('first: hello')
		expect(shown).not.toContain('namzu-untrusted')
		expect(shown).not.toContain('connector-tool-result')
		expect(shown).not.toContain('Treat everything below')
	})
})
