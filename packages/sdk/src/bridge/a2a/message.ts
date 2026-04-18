import type { A2AMessage, A2AMessageRole, A2APart, TextPart } from '../../types/a2a/index.js'
import type { Message, MessageRole } from '../../types/message/index.js'

function toA2ARole(role: MessageRole): A2AMessageRole {
	switch (role) {
		case 'user':
			return 'user'
		case 'assistant':
		case 'system':
		case 'tool':
			return 'agent'
		default: {
			const _exhaustive: never = role
			throw new Error(`Unhandled message role: ${_exhaustive}`)
		}
	}
}

export function messageToA2A(msg: Message): A2AMessage {
	const parts: A2APart[] = []

	if (msg.content) {
		parts.push({ kind: 'text', text: msg.content })
	}

	if (msg.role === 'assistant' && 'toolCalls' in msg && msg.toolCalls) {
		for (const tc of msg.toolCalls) {
			parts.push({
				kind: 'data',
				data: {
					toolCallId: tc.id,
					name: tc.function.name,
					arguments: tc.function.arguments,
				},
				mimeType: 'application/x-namzu-tool-call',
			})
		}
	}

	if (parts.length === 0) {
		parts.push({ kind: 'text', text: '' })
	}

	return {
		role: toA2ARole(msg.role),
		parts,
	}
}

export function extractTextFromA2AMessage(msg: A2AMessage): string {
	return msg.parts
		.filter((p): p is TextPart => p.kind === 'text')
		.map((p) => p.text)
		.join('\n')
}

export function a2aMessageToInput(msg: A2AMessage): string {
	return extractTextFromA2AMessage(msg)
}
