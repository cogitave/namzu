/** Verified Markdown projection of one CLI conversation. */

import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { link, lstat, open, readdir, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
	DefaultPathBuilder,
	type Message,
	type MessageAttachment,
	type PersistedRunEvent,
	type SessionId,
	type ToolMessage,
	readRunEventsIn,
	readRunMessagesIn,
} from '@namzu/sdk'
import { visibleProjectInstructionPath } from '../../context/project-path.js'
import type { CliSessions } from './store.js'
import type {
	ConversationTurnEvidence,
	ConversationTurnOutcome,
	DiskConversationEvidence,
} from './turn-evidence.js'

export type ConversationTranscriptUnavailableReason =
	| 'evidence-not-recorded'
	| 'fork-lineage-unavailable'
	| 'nothing-to-export'
	| 'unbound-run'
	| 'run-record-corrupt'
	| 'run-incomplete'
	| 'run-snapshot-unavailable'
	| 'run-snapshot-unverified'
	| 'run-snapshot-out-of-sync'
	| 'turn-run-mismatch'
	| 'turn-settlement-mismatch'

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

/**
 * Reconstruct a conversation from caller/run correlation plus the SDK's
 * strictly read, event-head-verified run records.
 */
export async function conversationMarkdown(
	sessions: CliSessions,
	sessionId: SessionId,
): Promise<ConversationMarkdownExport> {
	const evidenceStore = sessions.turnEvidence
	if (!evidenceStore) {
		throw unavailable(
			'evidence-not-recorded',
			'this host did not provide the CLI turn-evidence store',
		)
	}
	const evidence = await evidenceStore.read(sessionId)
	if (evidence.kind === 'not-recorded') {
		throw unavailable(
			'evidence-not-recorded',
			`conversation ${sessionId} predates durable turn/run correlation`,
		)
	}
	if (evidence.origin.origin.kind === 'fork-unresolved') {
		throw unavailable(
			'fork-lineage-unavailable',
			`conversation ${sessionId} is a fork whose copied prefix is not yet tied to stable source turns`,
		)
	}
	let lineage: Awaited<ReturnType<DiskConversationEvidence['resolveLineage']>>
	try {
		lineage = await evidenceStore.resolveLineage(sessionId)
	} catch (error) {
		throw unavailable(
			'fork-lineage-unavailable',
			`conversation ${sessionId} has invalid fork lineage: ${messageOf(error)}`,
		)
	}
	if (lineage.kind === 'unavailable') {
		throw unavailable('fork-lineage-unavailable', lineage.detail)
	}
	if (lineage.turns.length === 0) {
		throw unavailable('nothing-to-export', `conversation ${sessionId} has no recorded turns`)
	}

	const paths = new DefaultPathBuilder(sessions.root)
	const runsRoot = join(paths.sessionDir(sessions.projectId, sessionId), 'runs')
	const onDiskRunIds = await listRunIds(runsRoot)
	const boundRunIds = new Set(lineage.localTurns.map((turn) => turn.started.runId as string))
	const unbound = onDiskRunIds.filter((runId) => !boundRunIds.has(runId))
	if (unbound.length > 0) {
		throw unavailable(
			'unbound-run',
			`session ${sessionId} contains run evidence with no CLI turn binding: ${unbound.join(', ')}`,
		)
	}

	const lines = ['# Namzu conversation', '', `Conversation: \`${sessionId}\``, '']
	for (const inherited of lineage.turns) {
		const turn = inherited.evidence
		lines.push(...renderUser(turn), '')
		const runDir = paths.runDir(
			sessions.projectId,
			inherited.reference.sessionId,
			turn.started.runId,
		)
		if (!(await isDirectory(runDir))) {
			if (turn.settled?.outcome === 'cancelled' && turn.settled.assistantText.length === 0) {
				lines.push(
					'## Activity',
					'',
					'Run was cancelled before model execution began; no SDK run record was published.',
					'',
				)
				continue
			}
			if (turn.settled) {
				throw unavailable(
					'turn-run-mismatch',
					`turn ${turn.started.turnId} settled in the host but run ${turn.started.runId} has no SDK record`,
				)
			}
			lines.push('## Activity', '', 'Run did not start; no SDK run record was published.', '')
			continue
		}

		let events: readonly PersistedRunEvent[]
		try {
			events = await readRunEventsIn(runDir, { integrity: 'strict' })
		} catch (error) {
			throw unavailable(
				'run-record-corrupt',
				`run ${turn.started.runId} cannot be read strictly: ${messageOf(error)}`,
			)
		}
		if (
			events.length === 0 ||
			events[0]?.type !== 'run_started' ||
			events.some((event) => event.runId !== turn.started.runId)
		) {
			throw unavailable(
				'run-record-corrupt',
				`run ${turn.started.runId} is empty, lacks its start record, or contains another run's events`,
			)
		}
		const terminal = terminalEvent(events)
		if (terminal.kind === 'invalid' || (terminal.kind === 'absent' && !turn.settled)) {
			throw unavailable(
				'run-incomplete',
				`run ${turn.started.runId} has no unique terminal event at the durable log head and no host settlement that can close an interrupted turn`,
			)
		}

		let snapshot: Awaited<ReturnType<typeof readRunMessagesIn>>
		try {
			snapshot = await readRunMessagesIn(runDir)
		} catch (error) {
			throw unavailable(
				'run-record-corrupt',
				`run ${turn.started.runId} has an invalid message snapshot: ${messageOf(error)}`,
			)
		}
		if (snapshot.kind === 'unavailable') {
			throw unavailable(
				'run-snapshot-unavailable',
				`run ${turn.started.runId} never published its survivor snapshot`,
			)
		}
		if (snapshot.kind === 'legacy-unverified') {
			throw unavailable(
				'run-snapshot-unverified',
				`run ${turn.started.runId} has a legacy snapshot with no event-log boundary`,
			)
		}
		const eventHead = events.at(-1)?.seq ?? 0
		if (snapshot.throughEventSeq !== eventHead) {
			throw unavailable(
				'run-snapshot-out-of-sync',
				`run ${turn.started.runId} snapshot ends at event ${snapshot.throughEventSeq}, while its log ends at ${eventHead}`,
			)
		}

		const fullMessages = [
			...events.flatMap((event) => (event.type === 'compaction_shed' ? event.messages : [])),
			...snapshot.messages,
		]
		const userIndex = findExactUser(fullMessages, turn.started.user)
		if (userIndex < 0) {
			throw unavailable(
				'turn-run-mismatch',
				`run ${turn.started.runId} does not contain the exact user message bound before it started`,
			)
		}
		const produced = fullMessages.slice(userIndex + 1)
		const assistants = produced.filter((message) => message.role === 'assistant')
		const completions = events.filter((event) => event.type === 'message_completed')
		if (completions.length !== assistants.length) {
			throw unavailable(
				'turn-run-mismatch',
				`run ${turn.started.runId} records ${completions.length} completed model messages but its verified history contains ${assistants.length}`,
			)
		}
		for (let index = 0; index < completions.length; index += 1) {
			const recorded = completions[index]?.content
			const persisted = assistants[index]?.content
			if (recorded !== undefined && recorded !== (typeof persisted === 'string' ? persisted : '')) {
				throw unavailable(
					'turn-run-mismatch',
					`run ${turn.started.runId} message completion disagrees with its verified history`,
				)
			}
		}

		const completedText = assistants
			.map((message) => (typeof message.content === 'string' ? message.content : ''))
			.join('')
		let hostOnlyPartial = ''
		if (turn.settled) {
			const expectedOutcome =
				terminal.kind === 'present' ? terminalOutcome(terminal.event) : 'cancelled'
			if (
				turn.settled.outcome !== expectedOutcome ||
				!turn.settled.assistantText.startsWith(completedText)
			) {
				throw unavailable(
					'turn-settlement-mismatch',
					`turn ${turn.started.turnId} settlement disagrees with terminal run ${turn.started.runId}`,
				)
			}
			hostOnlyPartial = turn.settled.assistantText.slice(completedText.length)
		} else if (terminal.kind !== 'present' || terminal.event.type !== 'run_completed') {
			throw unavailable(
				'run-incomplete',
				`turn ${turn.started.turnId} lacks host settlement evidence after ${terminal.kind === 'present' ? terminal.event.type : 'an unterminated run'}`,
			)
		}

		lines.push(...renderProducedMessages(produced))
		if (hostOnlyPartial.length > 0) {
			lines.push(
				'## Assistant',
				'',
				'_Partial output captured by the terminal host before the model message closed._',
				'',
				hostOnlyPartial,
				'',
			)
		}
		lines.push(...renderRecordedActivity(events, produced), '')
	}

	return {
		sessionId,
		turns: lineage.turns.length,
		markdown: `${trimBlankTail(lines).join('\n')}\n`,
	}
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

function renderUser(turn: ConversationTurnEvidence): string[] {
	if (turn.started.user.source?.type === 'goal-round') {
		const source = turn.started.user.source
		return [
			`## Goal round ${source.round} / ${source.maxGoalRounds}`,
			'',
			`Objective: ${source.objective}`,
			'',
			'Model-visible continuation prompt:',
			'',
			turn.started.user.content,
		]
	}
	const lines = ['## User', '', turn.started.displayText]
	const attachments = turn.started.user.attachments ?? []
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
					lines.push(
						`## Goal round ${message.source.round} / ${message.source.maxGoalRounds}`,
						'',
						`Objective: ${message.source.objective}`,
						'',
						message.content,
						'',
					)
				} else lines.push('## User', '', message.content, '')
				break
			case 'system':
				// System and working-memory messages are model context, not operator
				// conversation. Compaction itself is rendered from its durable event.
				break
		}
	}
	return lines
}

function renderRecordedActivity(
	events: readonly PersistedRunEvent[],
	produced: readonly Message[],
): string[] {
	const representedTools = new Set<string>()
	for (const message of produced) {
		if (message.role === 'assistant') {
			for (const call of message.toolCalls ?? []) representedTools.add(call.id)
		}
		if (message.role === 'tool') representedTools.add(message.toolCallId)
	}
	const lines: string[] = []
	const activity = (text: string, detail?: string, language = '') => {
		lines.push('## Activity', '', text)
		if (detail !== undefined && detail.length > 0) lines.push('', ...fence(detail, language))
		lines.push('')
	}
	for (const event of events) {
		switch (event.type) {
			case 'tool_executing':
				if (event.via || !representedTools.has(event.toolUseId)) {
					activity(
						`Nested tool started: \`${event.toolName}\`${event.via ? ` via \`${event.via.tool}\`` : ''}`,
						jsonText(event.input),
						'json',
					)
				}
				break
			case 'tool_completed':
				if (event.via || !representedTools.has(event.toolUseId)) {
					activity(
						`Nested tool ${event.isError ? 'failed' : 'completed'}: \`${event.toolName}\`${event.outputTruncated ? ' (output preview; full output was spilled)' : ''}`,
						event.result,
					)
				}
				break
			case 'provider_fallback':
				activity(
					`Provider fallback: ${event.fromProviderId}${event.fromModel ? `/${event.fromModel}` : ''} → ${event.toProviderId}${event.toModel ? `/${event.toModel}` : ''} (${event.reason})`,
				)
				break
			case 'capability_warning':
				activity(`Capability warning (${event.capability}): ${event.message}`)
				break
			case 'message_history_repaired':
				activity(
					`Tool history repaired (${event.source}): ${event.duplicateToolResultsRemoved} duplicate result(s) removed, ${event.orphanedToolResultsRemoved} orphaned result(s) removed, ${event.syntheticToolResultsInserted} interrupted call(s) closed with unknown outcome.`,
				)
				break
			case 'compaction_completed':
				activity(
					`Context compacted: ${event.messagesBefore} → ${event.messagesAfter} messages; ${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} tokens.`,
				)
				break
			case 'compaction_tool_results_cleared':
				activity(
					`Context relief cleared ${event.clearedCount} oversized tool result${event.clearedCount === 1 ? '' : 's'} (~${event.reclaimedTokens.toLocaleString()} tokens).`,
				)
				break
			case 'compaction_failed':
				activity(`Context compaction did not change history (${event.cause}).`)
				break
			case 'guardrail_triggered':
				activity(
					`${event.stage === 'input' ? 'Input' : 'Output'} guardrail ${event.action}${event.guardrail ? ` (${event.guardrail})` : ''}${event.reason ? `: ${event.reason}` : '.'}`,
				)
				break
			case 'task_created':
				activity(`Task ${event.status}: ${event.subject}`)
				break
			case 'task_updated':
				if (event.status === 'completed') activity(`Task completed: ${event.subject}`)
				break
			case 'run_completed':
				if (event.stopReason && event.stopReason !== 'end_turn') {
					activity(`Run stopped: ${event.stopReason}.`)
				}
				break
			case 'run_failed':
				activity(`Run failed${event.failure ? ` [${event.failure.code}]` : ''}: ${event.error}`)
				break
			case 'run_paused':
				activity(`Run paused: ${event.reason}`)
				break
		}
	}
	return lines
}

type TerminalEvent = Extract<
	PersistedRunEvent,
	{ type: 'run_completed' | 'run_failed' | 'run_paused' }
>

function terminalEvent(
	events: readonly PersistedRunEvent[],
):
	| { readonly kind: 'present'; readonly event: TerminalEvent }
	| { readonly kind: 'absent' }
	| { readonly kind: 'invalid' } {
	const terminals = events.filter(
		(event): event is TerminalEvent =>
			event.type === 'run_completed' || event.type === 'run_failed' || event.type === 'run_paused',
	)
	if (terminals.length === 0) return { kind: 'absent' }
	const terminal = terminals[0]
	return terminals.length === 1 && terminal === events.at(-1)
		? { kind: 'present', event: terminal }
		: { kind: 'invalid' }
}

function terminalOutcome(
	event: Extract<PersistedRunEvent, { type: 'run_completed' | 'run_failed' | 'run_paused' }>,
): ConversationTurnOutcome {
	if (event.type === 'run_failed') return 'failed'
	if (event.type === 'run_paused') return 'stopped'
	if (event.stopReason === 'cancelled') return 'cancelled'
	return event.stopReason === undefined || event.stopReason === 'end_turn' ? 'completed' : 'stopped'
}

function findExactUser(messages: readonly Message[], expected: Message): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === 'user' && isDeepStrictEqual(messages[index], expected))
			return index
	}
	return -1
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

async function listRunIds(root: string): Promise<string[]> {
	let entries: Dirent[]
	try {
		entries = await readdir(root, { withFileTypes: true, encoding: 'utf-8' })
	} catch (error) {
		if (isCode(error, 'ENOENT')) return []
		throw error
	}
	const ids: string[] = []
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		if (!/^run_[a-z0-9]+$/.test(entry.name)) {
			throw unavailable(
				'run-record-corrupt',
				`session run directory has an invalid name: ${entry.name}`,
			)
		}
		ids.push(entry.name)
	}
	return ids.sort()
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		const value = await lstat(path)
		if (value.isSymbolicLink()) {
			throw unavailable('run-record-corrupt', `run path is a symbolic link: ${path}`)
		}
		return value.isDirectory()
	} catch (error) {
		if (isCode(error, 'ENOENT')) return false
		throw error
	}
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
