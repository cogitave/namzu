import { type Message, createRuntimeContextMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { instructionsDigest, mcpInstructionsReminders } from '../mcp-instructions.js'

const frame = (server: { name: string; text: string }) => `[[${server.name}]] ${server.text}`

function told(servers: { name: string; text: string }[], history: Message[] = []): Message[] {
	const out = [...history, createUserMessage('go')]
	for (const text of mcpInstructionsReminders({ messages: out, servers, frame })) {
		out.push(createRuntimeContextMessage(text, 'reminder'))
	}
	return out
}

const tickets = { name: 'tickets', text: 'Close a ticket with its number.' }
const wiki = { name: 'wiki', text: 'Pages are markdown.' }

describe('the tool server instructions reminder', () => {
	it('says each server what it supplied, framed, once', () => {
		const [first, ...rest] = mcpInstructionsReminders({
			messages: [createUserMessage('go')],
			servers: [tickets, wiki],
			frame,
		})
		expect(rest).toEqual([])
		expect(first).toContain('kind="mcp-instructions"')
		expect(first).toContain('[[tickets]] Close a ticket with its number.')
		expect(first).toContain('[[wiki]] Pages are markdown.')
		expect(first).toContain('not from the operator')
	})

	it('says nothing for a server without text, or when nobody opted in', () => {
		expect(
			mcpInstructionsReminders({
				messages: [createUserMessage('go')],
				servers: [{ name: 'blank', text: '  ' }],
				frame,
			}),
		).toEqual([])
		expect(
			mcpInstructionsReminders({ messages: [createUserMessage('go')], servers: [], frame }),
		).toEqual([])
	})

	it('stays quiet while the text is what it last said', () => {
		let messages = told([tickets])
		for (let turn = 0; turn < 4; turn++) messages = told([tickets], messages)
		expect(mcpInstructionsReminders({ messages, servers: [tickets], frame })).toEqual([])
		expect(messages.filter((m) => String(m.content).includes('mcp-instructions'))).toHaveLength(1)
	})

	it('repeats only the server whose text changed', () => {
		const messages = told([tickets, wiki])
		const [changed] = mcpInstructionsReminders({
			messages,
			servers: [{ ...tickets, text: 'Close a ticket with its key.' }, wiki],
			frame,
		})
		expect(changed).toContain('with its key')
		expect(changed).not.toContain('[[wiki]]')
		expect(changed).toContain('changed since you were last told')
	})

	it('says a server that stopped supplying text no longer applies, once', () => {
		const messages = told([tickets, wiki])
		const [gone] = mcpInstructionsReminders({ messages, servers: [wiki], frame })
		expect(gone).toContain('<mcp_server_gone name="tickets"/>')
		expect(gone).toContain('no longer applies')
		const after = told([wiki], messages)
		expect(mcpInstructionsReminders({ messages: after, servers: [wiki], frame })).toEqual([])
	})

	it('says a returning server again after it was withdrawn', () => {
		const withdrawn = told([wiki], told([tickets, wiki]))
		const [back] = mcpInstructionsReminders({
			messages: withdrawn,
			servers: [tickets, wiki],
			frame,
		})
		expect(back).toContain('[[tickets]]')
	})

	it('says everything again once a compaction dropped the earlier reminder', () => {
		const messages = told([tickets]).filter((m) => !String(m.content).includes('mcp-'))
		expect(mcpInstructionsReminders({ messages, servers: [tickets], frame })).toHaveLength(1)
	})

	it('keys on the text, not on how it was framed', () => {
		expect(instructionsDigest('a')).toBe(instructionsDigest('a'))
		expect(instructionsDigest('a')).not.toBe(instructionsDigest('b'))
	})
})
