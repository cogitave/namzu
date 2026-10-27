import { type Message, createToolMessage } from '@namzu/sdk'

/**
 * A fork is a sub-agent that continues the caller's conversation: it starts
 * from the same messages and system prompt, runs on the same model, and gets
 * the same working set of tools as any other child. What it receives in place
 * of a brief is a directive, and what it hands back is one report.
 */
export const FORK_SUBAGENT = 'fork'

/** Marks the directive message, so a conversation that already holds one is known to be a fork's. */
const DIRECTIVE_TAG = 'fork-directive'

const OWN_CALL_RESULT =
	'This call started you as a fork. The directive below is yours; the call itself and its result belong to your parent.'
const OTHER_CALL_RESULT =
	'This call belongs to your parent and may not have run. Its result goes to your parent, not to you.'

/** The directive a fork receives as its one task. */
export function forkDirective(prompt: string, options: { readonly isolated: boolean }): string {
	return [
		`<${DIRECTIVE_TAG}>`,
		'You are a fork: a worker that continues from the conversation above to carry out one directive. That conversation is context you inherited, and the directive below is the task you were given.',
		'',
		'Rules, in order of importance (the directive may change any of them):',
		'- Carry out the directive yourself with your tools. You cannot start sub-agents or further forks, so there is nothing to delegate.',
		'- Stay inside the directive. If you notice something outside it, say so in one sentence and carry on; another fork may be handling it.',
		'- Report once and stop. Nobody can answer a question while you work, and your parent decides what happens next, so leave out follow-up questions and proposed next steps.',
		'- Open the report with one line restating your task, so your parent can see at a glance whether you drifted.',
		'- Keep the report as short as the answer allows, in plain text. List every path you changed and every commit you made.',
		'- Files may have changed since the conversation showed them. Read a file again before you edit it.',
		...(options.isolated
			? [
					'- You work in a separate Git checkout of the same repository. Paths in the conversation point to your parent’s checkout; use the same relative paths in yours.',
				]
			: []),
		`</${DIRECTIVE_TAG}>`,
		'',
		'Directive:',
		prompt,
	].join('\n')
}

/** True when the conversation already holds a fork's directive: the caller is itself a fork. */
export function isForkConversation(messages: readonly Message[]): boolean {
	const marker = `<${DIRECTIVE_TAG}>`
	return messages.some((message) => message.role === 'user' && message.content.includes(marker))
}

/**
 * The messages a fork starts from: the caller's conversation up to and
 * including the assistant message that issued the launching call, with every
 * call in that message answered by a short note, so the history is a valid
 * conversation the model can continue.
 *
 * When the launching message cannot be found (the call came from somewhere
 * other than a model turn), the conversation is cut back to its last complete
 * exchange instead.
 *
 * The system prompt travels separately, so a plain system message is left
 * out; a compaction summary is part of what the caller remembers and stays.
 */
export function forkSeed(history: readonly Message[], toolUseId: string | undefined): Message[] {
	const messages = history.filter((message) => message.role !== 'system' || message.source)
	let issuing = -1
	if (toolUseId !== undefined) {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index]
			if (
				message?.role === 'assistant' &&
				message.toolCalls?.some((call) => call.id === toolUseId)
			) {
				issuing = index
				break
			}
		}
	}
	if (issuing >= 0) {
		const issued = messages[issuing]
		const head = messages.slice(0, issuing + 1)
		if (issued?.role !== 'assistant') return head
		const answers = (issued.toolCalls ?? []).map((call) =>
			createToolMessage(call.id === toolUseId ? OWN_CALL_RESULT : OTHER_CALL_RESULT, call.id),
		)
		return [...head, ...answers]
	}
	return completeExchanges(messages)
}

/** The conversation without a trailing assistant message whose calls are not all answered. */
function completeExchanges(messages: readonly Message[]): Message[] {
	const answered = new Set<string>()
	for (const message of messages) {
		if (message.role === 'tool') answered.add(message.toolCallId)
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message?.role !== 'assistant') continue
		if ((message.toolCalls ?? []).every((call) => answered.has(call.id))) break
		return messages.slice(0, index)
	}
	return [...messages]
}
