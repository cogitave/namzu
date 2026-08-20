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

/**
 * Host-owned live project policy for one run.
 *
 * Tool results are observed only after the registry has produced its final
 * result. `takeSnapshotUpdate` is a separate, continuation-neutral channel:
 * the loop persists its replacement after a complete tool batch even when a
 * terminal tool or stop predicate means there will be no next model request.
 * `undefined` means no change; `null` explicitly removes the old snapshot.
 */
export interface ProjectInstructionContext {
	/**
	 * Rebuild the first-request snapshot from host authority. Persisted source
	 * paths may guide discovery; persisted policy text must not be trusted.
	 * `undefined` leaves history unchanged, while `null` removes stale state.
	 */
	prepareInitialSnapshot?(
		messages: readonly Message[],
	): UserMessage | null | undefined | Promise<UserMessage | null | undefined>
	observeToolResult(observation: ToolResultObservation): void | Promise<void>
	takeSnapshotUpdate(): UserMessage | null | undefined | Promise<UserMessage | null | undefined>
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
			return index === latest ? [{ ...message, retain: true }] : []
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
