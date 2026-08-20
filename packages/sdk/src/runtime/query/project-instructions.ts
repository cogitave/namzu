import { isDeepStrictEqual } from 'node:util'

import { NamzuError } from '../../types/errors/index.js'
import type { RunId } from '../../types/ids/index.js'
import {
	type Message,
	type UserMessage,
	isProjectInstructionMessageSource,
} from '../../types/message/index.js'
import type { ToolResult } from '../../types/tool/index.js'

/** One real registry execution, after retries and its terminal event. */
export interface ToolResultObservation {
	readonly runId: RunId
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
	/** The run-owned cancellation signal for any host I/O the callback starts. */
	readonly signal: AbortSignal
}

export type ProjectInstructionSnapshotUpdate = UserMessage | null | undefined

/**
 * Host-owned live project policy for one run.
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
 * Keep only the latest structurally valid project snapshot, at its own
 * chronological position. Invalid tagged provenance refuses before a provider
 * can be called; an untrusted persisted object cannot acquire policy status by
 * spelling one discriminator.
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
	return messages.flatMap((message, index) => {
		if (message.role === 'user' && message.source?.type === 'project-instructions') {
			return index === latest
				? [message.retain === true ? message : { ...message, retain: true }]
				: []
		}
		return [message]
	})
}

/**
 * Replace project policy without mutating the caller's history.
 *
 * Runtime updates append after the finalized tool batch. A host seeding a new
 * human turn uses `before-latest-user`, so the policy is context for that
 * request rather than a reply after it.
 */
export function replaceProjectInstructionSnapshot(
	messages: readonly Message[],
	snapshot: UserMessage | null,
	placement: 'append' | 'before-latest-user' = 'append',
): Message[] {
	if (snapshot) assertsProjectInstructionMessage(snapshot)
	// Validate every tagged predecessor before removing it. A host-authoritative
	// replacement must not turn malformed persisted provenance into a silent
	// success merely because the bad record happens to be superseded.
	const validated = collapseProjectInstructionSnapshots(messages)
	let current: UserMessage | undefined
	for (let index = validated.length - 1; index >= 0; index -= 1) {
		const message = validated[index]
		if (message && isProjectInstructionMessage(message)) {
			current = message
			break
		}
	}
	if (
		snapshot !== null &&
		current !== undefined &&
		isDeepStrictEqual(
			{
				content: current.content,
				attachments: current.attachments,
				source: current.source,
				cacheHint: current.cacheHint,
			},
			{
				content: snapshot.content,
				attachments: snapshot.attachments,
				source: snapshot.source,
				cacheHint: snapshot.cacheHint,
			},
		)
	) {
		return validated
	}
	if (snapshot === null && current === undefined) return validated
	const without = validated.filter(
		(message) => !(message.role === 'user' && message.source?.type === 'project-instructions'),
	)
	if (!snapshot) return without
	const retained = snapshot.retain === true ? snapshot : { ...snapshot, retain: true }
	if (placement === 'append') return [...without, retained]
	let insertion = without.length
	for (let index = without.length - 1; index >= 0; index -= 1) {
		if (without[index]?.role === 'user') {
			insertion = index
			break
		}
	}
	return [...without.slice(0, insertion), retained, ...without.slice(insertion)]
}
