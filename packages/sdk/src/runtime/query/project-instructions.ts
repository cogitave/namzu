import { isDeepStrictEqual } from 'node:util'

import { NamzuError } from '../../types/errors/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import {
	type Message,
	type UserMessage,
	isProjectInstructionMessageSource,
} from '../../types/message/index.js'
import type { ToolResult } from '../../types/tool/index.js'

/** One real registry execution, after retries and its terminal event. */
export interface ToolResultObservation {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	readonly toolUseId: string
	readonly toolName: string
	readonly input: unknown
	readonly result: ToolResult
	/** Present when another tool dispatched this call. */
	readonly parentToolUseId?: string
}

/** Authority and durable conversation visible to one host policy callback. */
export interface ProjectInstructionCallbackContext {
	/** A snapshot of the messages accepted before this callback starts. */
	readonly messages: readonly Message[]
	/** The turn-owned cancellation signal for any host I/O the callback starts. */
	readonly signal: AbortSignal
}

export type ProjectInstructionSnapshotUpdate = UserMessage | null | undefined

/**
 * Host-owned live project policy for one turn.
 *
 * Tool results are observed only after the registry has produced its final
 * result and the complete tool-result batch is in `context.messages`. Each
 * accepted observation returns its desired complete snapshot and the loop
 * persists it before entering the next observation. `undefined` means no
 * change; `null` explicitly removes the old snapshot.
 *
 * Callbacks must derive publication decisions from `context.messages`, not
 * advance a private "published" cursor before returning: cancellation may win
 * after host work finishes but before the returned value is accepted.
 */
export interface ProjectInstructionContext {
	/**
	 * Rebuild the first-request snapshot from host authority. Persisted source
	 * paths may guide discovery; persisted policy text must not be trusted.
	 * `undefined` leaves history unchanged, while `null` removes stale state.
	 */
	prepareInitialSnapshot?(
		context: ProjectInstructionCallbackContext,
	): ProjectInstructionSnapshotUpdate | Promise<ProjectInstructionSnapshotUpdate>
	observeToolResult(
		observation: ToolResultObservation,
		context: ProjectInstructionCallbackContext,
	): ProjectInstructionSnapshotUpdate | Promise<ProjectInstructionSnapshotUpdate>
}

/**
 * Await opaque host work without giving it ownership of run cancellation.
 *
 * The callback receives the signal for cooperative cleanup. The independent
 * settlement boundary is still required: a host implementation that ignores
 * the signal may continue its own work, but it cannot keep Namzu pending or
 * publish a value after authority was withdrawn.
 */
export async function awaitProjectInstructionCallback<T>(
	signal: AbortSignal,
	start: () => T | Promise<T>,
): Promise<T> {
	signal.throwIfAborted()

	return new Promise<T>((resolve, reject) => {
		let settled = false
		const cleanup = (): void => signal.removeEventListener('abort', onAbort)
		const rejectOnce = (reason: unknown): void => {
			if (settled) return
			settled = true
			cleanup()
			reject(reason)
		}
		const resolveOnce = (value: T): void => {
			if (settled) return
			settled = true
			cleanup()
			resolve(value)
		}
		// Abort delivery is synchronous. This first-cause latch decides whether
		// host completion or authority withdrawal owns publication, even when
		// both happen in the same event-loop turn.
		const onAbort = (): void => rejectOnce(signal.reason)

		signal.addEventListener('abort', onAbort, { once: true })
		try {
			Promise.resolve(start()).then(resolveOnce, rejectOnce)
		} catch (error) {
			rejectOnce(error)
		}
	})
}

export function isProjectInstructionMessage(message: Message): message is UserMessage {
	return (
		message.role === 'user' &&
		message.source?.type === 'project-instructions' &&
		isProjectInstructionMessageSource(message.source)
	)
}

function assertsProjectInstructionMessage(message: UserMessage): asserts message is UserMessage & {
	readonly source: {
		readonly type: 'project-instructions'
		readonly files: readonly string[]
	}
} {
	if (!isProjectInstructionMessage(message)) {
		throw new NamzuError({
			code: 'invalid_config',
			message:
				'A project-instruction snapshot must be a user message with valid project-relative provenance.',
		})
	}
}

/**
 * The line that opens a changed copy of the project instructions. The copy is
 * complete, so the model can drop the earlier one outright.
 */
export const PROJECT_INSTRUCTION_UPDATE_HEADER =
	'Updated project instructions. These replace the project instructions given earlier in this conversation in full; a rule that appears only in the earlier copy no longer applies.\n\n'

function isUpdate(message: UserMessage): boolean {
	return message.source?.type === 'project-instructions' && message.source.update === true
}

/** The policy text of a snapshot, without the header an update carries. */
export function projectInstructionBody(message: UserMessage): string {
	const content = typeof message.content === 'string' ? message.content : ''
	return isUpdate(message) && content.startsWith(PROJECT_INSTRUCTION_UPDATE_HEADER)
		? content.slice(PROJECT_INSTRUCTION_UPDATE_HEADER.length)
		: content
}

/**
 * Keep the project policy a request needs, each at its own chronological
 * position. A plain snapshot supersedes every earlier one. A changed copy
 * (`source.update`) supersedes the copies before it but leaves the first one
 * in place, so the request keeps its shape up to the change. Invalid tagged
 * provenance refuses before a provider can be called; an untrusted persisted
 * object cannot acquire policy status by spelling one discriminator.
 */
export function collapseProjectInstructionSnapshots(messages: readonly Message[]): Message[] {
	let latest = -1
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index]
		if (message?.role !== 'user' || message.source?.type !== 'project-instructions') continue
		assertsProjectInstructionMessage(message)
		latest = index
	}
	if (latest < 0) return [...messages]
	const latestMessage = messages[latest] as UserMessage
	// The base is the earliest copy, kept only while the latest is an update of it.
	let base = -1
	if (isUpdate(latestMessage)) {
		for (let index = 0; index < latest; index += 1) {
			const message = messages[index]
			if (message && isProjectInstructionMessage(message)) {
				base = index
				break
			}
		}
	}
	return messages.flatMap((message, index) => {
		if (message.role === 'user' && message.source?.type === 'project-instructions') {
			return index === latest || index === base
				? [message.retain === true ? message : { ...message, retain: true }]
				: []
		}
		return [message]
	})
}

function canonical(message: UserMessage): unknown {
	// Through JSON, as the durable record went: an explicitly undefined field and
	// a missing one are the same message.
	return JSON.parse(
		JSON.stringify({
			content: projectInstructionBody(message),
			attachments: message.attachments,
			source: message.source ? { ...message.source, update: undefined } : message.source,
			cacheHint: message.cacheHint,
		}),
	)
}

/** Whether two snapshots say the same thing, ignoring ids, timestamps and `retain`. */
export function sameProjectInstructionSnapshot(a: UserMessage, b: UserMessage): boolean {
	return isDeepStrictEqual(canonical(a), canonical(b))
}

/** The latest project-instruction snapshot in `messages`, if there is one. */
export function latestProjectInstructionSnapshot(
	messages: readonly Message[],
): UserMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message && isProjectInstructionMessage(message)) return message
	}
	return undefined
}

/**
 * Replace project policy without mutating the caller's history.
 *
 * The first copy a conversation holds keeps its place. A changed snapshot is
 * sent as a complete update at the tail (`source.update`), which replaces the
 * earlier updates and tells the model it supersedes the first copy; the
 * request is unchanged up to the update, so a provider's cache still covers it.
 * Runtime updates append after the finalized tool batch. A host seeding a new
 * human turn uses `before-latest-user`, so the policy is context for that
 * request rather than a reply after it.
 */
export function replaceProjectInstructionSnapshot(
	messages: readonly Message[],
	snapshot: UserMessage | null,
	placement: 'append' | 'before-latest-user' = 'append',
	/** Messages the conversation already holds ahead of `messages`; read for the first copy, never changed. */
	held: readonly Message[] = [],
): Message[] {
	if (snapshot) assertsProjectInstructionMessage(snapshot)
	// Validate every tagged predecessor before removing it. A host-authoritative
	// replacement must not turn malformed persisted provenance into a silent
	// success merely because the bad record happens to be superseded.
	const validated = collapseProjectInstructionSnapshots(messages)
	const all = collapseProjectInstructionSnapshots([...held, ...messages])
	const current = latestProjectInstructionSnapshot(all)
	if (
		snapshot !== null &&
		current !== undefined &&
		sameProjectInstructionSnapshot(current, snapshot)
	) {
		return validated
	}
	if (snapshot === null && current === undefined) return validated
	const isPolicy = (message: Message): boolean =>
		message.role === 'user' && message.source?.type === 'project-instructions'
	const without = validated.filter((message) => !isPolicy(message))
	if (!snapshot) return without
	const place = (list: readonly Message[], message: UserMessage): Message[] => {
		if (placement === 'append') return [...list, message]
		let insertion = list.length
		for (let index = list.length - 1; index >= 0; index -= 1) {
			if (list[index]?.role === 'user') {
				insertion = index
				break
			}
		}
		return [...list.slice(0, insertion), message, ...list.slice(insertion)]
	}
	const base = all.find(
		(message): message is UserMessage => isProjectInstructionMessage(message) && !isUpdate(message),
	)
	const body = projectInstructionBody(snapshot)
	if (base === undefined) {
		const first: UserMessage =
			snapshot.retain === true && !isUpdate(snapshot)
				? snapshot
				: {
						...snapshot,
						content: body,
						source: {
							type: 'project-instructions',
							files: snapshot.source.files,
						},
						retain: true,
					}
		return place(without, first)
	}
	const update: UserMessage = {
		...snapshot,
		content: PROJECT_INSTRUCTION_UPDATE_HEADER + body,
		source: {
			type: 'project-instructions',
			files: snapshot.source.files,
			update: true,
		},
		retain: true,
	}
	const kept = validated.filter((message) => !isPolicy(message) || message === base)
	return place(kept, update)
}
