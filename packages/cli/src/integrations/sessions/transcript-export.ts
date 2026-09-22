/** Verified Markdown projection of one CLI conversation, read from its session log. */

import { randomUUID } from 'node:crypto'
import { link, open, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type {
	Message,
	MessageAttachment,
	SessionId,
	SessionRecord,
	ToolMessage,
	UserMessage,
} from '@namzu/sdk'
import { visibleProjectInstructionPath } from '../../context/project-path.js'
import { runtimeContextLabel } from '../../context/runtime-message.js'
import {
	type ConversationContext,
	type ConversationFacts,
	openConversationLog,
	readConversationFacts,
} from './store.js'

export type ConversationTranscriptUnavailableReason =
	| 'not-found'
	| 'log-unreadable'
	| 'nothing-to-export'

export class ConversationTranscriptUnavailableError extends Error {
	readonly reason: ConversationTranscriptUnavailableReason

	constructor(reason: ConversationTranscriptUnavailableReason, detail: string) {
		super(`Complete conversation export unavailable: ${detail}`)
		this.name = 'ConversationTranscriptUnavailableError'
		this.reason = reason
	}
}

export interface ConversationMarkdownExport {
	readonly sessionId: SessionId
	readonly turns: number
	readonly markdown: string
}

type MessageRecord = Extract<SessionRecord, { type: 'message' }>

/**
 * Reconstruct a conversation from its session log, read strictly: a log whose
 * hash chain is broken is refused rather than exported in part.
 *
 * Every turn is rendered from its own records — the prompt, the messages it
 * produced, the activity it recorded and how it ended. An answer the runtime
 * replaced (a guardrail rewrite, a review, a structured result) is shown as
 * replaced, exactly as every fold of the log shows it; the raw text stays in
 * the log for audit.
 */
export async function conversationMarkdown(
	sessions: ConversationContext,
	sessionId: SessionId,
): Promise<ConversationMarkdownExport> {
	let facts: ConversationFacts | null
	try {
		facts = await readConversationFacts(sessions, sessionId)
	} catch (error) {
		throw unavailable(
			'log-unreadable',
			`conversation ${sessionId} cannot be read strictly: ${messageOf(error)}`,
		)
	}
	if (!facts || facts.started.projectId !== sessions.projectId) {
		throw unavailable('not-found', `conversation ${sessionId} is not in this workspace`)
	}
	const log = openConversationLog(sessions, sessionId)
	const content = async (record: MessageRecord | { content: Message; spill?: unknown }) => {
		const spill = (record as { spill?: Parameters<typeof log.readSpill>[0] }).spill
		return spill ? (JSON.parse(await log.readSpill(spill)) as Message) : record.content
	}

	// The latest replacement of each message wins, as in every fold (§4.4).
	const replacements = new Map<string, Message>()
	for (const record of facts.records) {
		if (record.type === 'message_replaced') {
			replacements.set(record.targetMessageId, await content(record))
		}
	}

	const lines = ['# Namzu conversation', '', `Conversation: \`${sessionId}\``, '']
	let turns = 0
	let current: string | undefined
	let produced: Message[] = []
	const flush = (): void => {
		if (produced.length > 0) lines.push(...renderProducedMessages(produced))
		produced = []
	}
	for (const record of facts.records) {
		switch (record.type) {
			case 'compaction':
				flush()
				if (record.strategy === 'fork' && Array.isArray(record.summary)) {
					// The prompts a fork copied are turns of this conversation too.
					turns += record.summary.filter(
						(message) =>
							message.role === 'user' &&
							(message.source === undefined || message.source.type === 'goal-round'),
					).length
					lines.push(
						'## Copied history',
						'',
						'_Copied from the conversation this one was forked from._',
						'',
					)
					lines.push(...renderProducedMessages(record.summary))
				} else {
					lines.push(
						'## Activity',
						'',
						`Context compacted (${record.trigger}): ${record.tokensBefore.toLocaleString()} → ${record.tokensAfter.toLocaleString()} tokens.`,
						'',
					)
				}
				break
			case 'turn_started':
				flush()
				current = record.turnId
				turns += 1
				break
			case 'message': {
				const message = replacements.get(record.messageId) ?? (await content(record))
				if (record.kind === 'prompt' && message.role === 'user') {
					flush()
					lines.push(...renderUser(message), '')
				} else produced.push(message)
				break
			}
			case 'turn_completed':
				flush()
				if (record.stopReason && record.stopReason !== 'end_turn') {
					lines.push('## Activity', '', `Turn stopped: ${record.stopReason}.`, '')
				}
				current = undefined
				break
			case 'turn_failed':
				flush()
				lines.push(
					'## Activity',
					'',
					`Turn failed${record.failure ? ` [${record.failure.code}]` : ''}: ${record.error}`,
					'',
				)
				current = undefined
				break
			case 'turn_paused':
				flush()
				lines.push('## Activity', '', `Turn paused: ${record.reason}`, '')
				break
			default: {
				const activity = renderRecordedActivity(record, produced)
				if (activity.length > 0) {
					flush()
					lines.push(...activity)
				}
			}
		}
	}
	flush()
	if (current !== undefined && facts.activeTurn && !facts.activeTurn.paused) {
		lines.push(
			'## Activity',
			'',
			'This turn has not settled: it is still running, or its process stopped before it finished.',
			'',
		)
	}
	if (turns === 0 && !facts.records.some((record) => record.type === 'compaction')) {
		throw unavailable('nothing-to-export', `conversation ${sessionId} has no recorded turns`)
	}
	return { sessionId, turns, markdown: `${trimBlankTail(lines).join('\n')}\n` }
}

export interface WriteConversationExportResult {
	readonly path: string
	readonly bytes: number
}

/** Write through a same-directory temporary inode, then link without clobbering. */
export async function writeConversationExport(
	markdown: string,
	destination: string,
	cwd: string,
): Promise<WriteConversationExportResult> {
	const target = resolveExportPath(destination, cwd)
	const parent = dirname(target)
	let parentStat: Awaited<ReturnType<typeof stat>>
	try {
		parentStat = await stat(parent)
	} catch (error) {
		throw new Error(`Export directory is unavailable: ${parent} (${messageOf(error)})`)
	}
	if (!parentStat.isDirectory()) throw new Error(`Export parent is not a directory: ${parent}`)

	const temporary = join(parent, `.${basename(target)}.tmp-${randomUUID()}`)
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(temporary, 'wx', 0o600)
		await handle.writeFile(markdown, 'utf-8')
		await handle.sync()
		await handle.close()
		handle = undefined
		try {
			await link(temporary, target)
		} catch (error) {
			if (isCode(error, 'EEXIST')) {
				throw new Error(`Export target already exists; nothing was overwritten: ${target}`)
			}
			throw error
		}
		return { path: target, bytes: Buffer.byteLength(markdown, 'utf-8') }
	} finally {
		await handle?.close()
		await unlink(temporary).catch((error: unknown) => {
			if (!isCode(error, 'ENOENT')) throw error
		})
	}
}

function renderUser(user: UserMessage): string[] {
	if (user.source?.type === 'goal-round') {
		const source = user.source
		return [
			`## Goal round ${source.round} / ${source.maxGoalRounds}`,
			'',
			`Objective: ${source.objective}`,
			'',
			'Model-visible continuation prompt:',
			'',
			user.content,
		]
	}
	const lines = ['## User', '', user.content]
	const attachments = user.attachments ?? []
	if (attachments.length > 0) {
		lines.push(
			'',
			'Attachments:',
			...attachments.map((attachment) => `- ${attachmentLabel(attachment)}`),
		)
	}
	return lines
}

function renderProducedMessages(messages: readonly Message[]): string[] {
	const lines: string[] = []
	for (const message of messages) {
		switch (message.role) {
			case 'assistant': {
				if (typeof message.content === 'string' && message.content.length > 0) {
					lines.push('## Assistant', '', message.content, '')
				}
				if (message.citations && message.citations.length > 0) {
					lines.push(
						'### Citations',
						'',
						...message.citations.flatMap((citation) => [
							`- ${citation.documentTitle ?? `Document ${citation.documentIndex + 1}`} — ${citationLocation(citation.location)}`,
							...indentQuote(citation.citedText),
						]),
						'',
					)
				}
				for (const call of message.toolCalls ?? []) {
					lines.push(
						'## Activity',
						'',
						`Tool started: \`${call.function.name}\``,
						'',
						...fence(call.function.arguments, 'json'),
						'',
					)
				}
				break
			}
			case 'tool':
				lines.push(
					'## Activity',
					'',
					`Tool result for \`${message.toolCallId}\``,
					'',
					...renderToolContent(message),
					'',
				)
				break
			case 'user':
				if (message.source?.type === 'project-instructions') {
					lines.push(
						'## Project instructions',
						'',
						...message.source.files.map((file) => `- ${visibleProjectInstructionPath(file)}`),
						'',
						message.content,
						'',
					)
				} else if (message.source?.type === 'goal-round') {
					lines.push(...renderUser(message), '')
				} else if (message.source?.type === 'runtime-context') {
					lines.push(
						`## Runtime context — ${runtimeContextLabel(message.source.kind)}`,
						'',
						message.content,
						'',
					)
				} else lines.push('## User', '', message.content, '')
				break
			case 'system':
				// System and working-memory messages are model context, not operator
				// conversation. Compaction itself is rendered from its record.
				break
		}
	}
	return lines
}

/** Activity a record carries that the messages around it do not already show. */
function renderRecordedActivity(record: SessionRecord, produced: readonly Message[]): string[] {
	const represented = (toolUseId: string): boolean =>
		produced.some(
			(message) =>
				(message.role === 'assistant' &&
					(message.toolCalls ?? []).some((call) => call.id === toolUseId)) ||
				(message.role === 'tool' && message.toolCallId === toolUseId),
		)
	const lines: string[] = []
	const activity = (text: string, detail?: string, language = '') => {
		lines.push('## Activity', '', text)
		if (detail !== undefined && detail.length > 0) lines.push('', ...fence(detail, language))
		lines.push('')
	}
	switch (record.type) {
		case 'tool_executing':
			if (record.via || !represented(record.toolUseId)) {
				activity(
					`Nested tool started: \`${record.toolName}\`${record.via ? ` via \`${record.via.tool}\`` : ''}`,
					jsonText(record.input),
					'json',
				)
			}
			break
		case 'tool_completed':
			if (record.via || !represented(record.toolUseId)) {
				activity(
					`Nested tool ${record.isError ? 'failed' : 'completed'}: \`${record.toolName}\`${record.outputTruncated ? ' (output preview; full output was spilled)' : ''}`,
					record.result,
				)
			}
			break
		case 'provider_fallback':
			activity(
				`Provider fallback: ${record.fromProviderId}${record.fromModel ? `/${record.fromModel}` : ''} → ${record.toProviderId}${record.toModel ? `/${record.toModel}` : ''} (${record.reason})`,
			)
			break
		case 'capability_warning':
			activity(`Capability warning (${record.capability}): ${record.message}`)
			break
		case 'message_history_repaired':
			if (record.source === 'provider-rejected-image') {
				activity(
					`Provider-rejected image delivery repaired: ${record.providerRejectedImagesSuppressed ?? 0} occurrence(s) retained in history and omitted from later model requests.`,
				)
			} else {
				activity(
					`Tool history repaired (${record.source}): ${record.duplicateToolResultsRemoved} duplicate result(s) removed, ${record.orphanedToolResultsRemoved} orphaned result(s) removed, ${record.syntheticToolResultsInserted} interrupted call(s) closed with unknown outcome.`,
				)
			}
			break
		case 'compaction_tool_results_cleared':
			activity(
				`Context relief cleared ${record.clearedCount} oversized tool result${record.clearedCount === 1 ? '' : 's'} (~${record.reclaimedTokens.toLocaleString()} tokens).`,
			)
			break
		case 'compaction_failed':
			activity(`Context compaction did not change history (${record.cause}).`)
			break
		case 'guardrail_triggered':
			activity(
				`${record.stage === 'input' ? 'Input' : 'Output'} guardrail ${record.action}${record.guardrail ? ` (${record.guardrail})` : ''}${record.reason ? `: ${record.reason}` : '.'}`,
			)
			break
		case 'task_created':
			activity(`Task ${record.status}: ${record.subject}`)
			break
		case 'task_updated':
			if (record.deleted) activity(`Task removed: ${record.subject}`)
			else if (record.status === 'completed') activity(`Task completed: ${record.subject}`)
			break
	}
	return lines
}

function renderToolContent(message: ToolMessage): string[] {
	if (typeof message.content === 'string') return fence(message.content)
	const rendered = message.content.map((block) => {
		if (block.type === 'text') return block.text
		if (block.type === 'image') return `[Image result: ${block.mediaType}; binary data omitted]`
		return `[Document result: ${block.name ?? 'unnamed'} · ${block.mediaType}; binary data omitted]`
	})
	return fence(rendered.join('\n'))
}

function attachmentLabel(attachment: MessageAttachment): string {
	if (attachment.type === 'stored') {
		return `${attachment.kind === 'image' ? 'Image' : 'Document'}: ${attachment.name ?? 'unnamed'} · ${attachment.mediaType} (stored reference; binary data omitted)`
	}
	if (attachment.type === 'document') {
		return `Document: ${attachment.name ?? 'unnamed'} · ${attachment.mediaType} (binary data omitted)`
	}
	return `Image: ${attachment.mediaType} (binary data omitted)`
}

function citationLocation(location: {
	readonly kind: 'page' | 'char' | 'block'
	readonly start: number
	readonly end: number
}): string {
	return `${location.kind} ${location.start}${location.end === location.start ? '' : `–${location.end}`}`
}

function indentQuote(text: string): string[] {
	return text.split('\n').map((line) => `  > ${line}`)
}

function fence(content: string, language = ''): string[] {
	const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length))
	const marker = '`'.repeat(Math.max(3, longest + 1))
	return [`${marker}${language}`, content, marker]
}

function jsonText(value: unknown): string {
	const encoded = JSON.stringify(value, null, 2)
	return encoded === undefined ? String(value) : encoded
}

function trimBlankTail(lines: string[]): string[] {
	while (lines.at(-1) === '') lines.pop()
	return lines
}

function resolveExportPath(destination: string, cwd: string): string {
	const expanded =
		destination === '~'
			? homedir()
			: destination.startsWith('~/')
				? join(homedir(), destination.slice(2))
				: destination
	return resolve(cwd, expanded)
}

function unavailable(
	reason: ConversationTranscriptUnavailableReason,
	detail: string,
): ConversationTranscriptUnavailableError {
	return new ConversationTranscriptUnavailableError(reason, detail)
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isCode(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
