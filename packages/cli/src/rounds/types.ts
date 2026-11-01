/**
 * What a round is made of, and the pure rules about it.
 *
 * A round is one model turn the screen is about to start: a person's message,
 * a peer's mail, a wake notice for work that ended while nobody was talking,
 * or an admitted goal round. These types and rules are the vocabulary of the
 * queue and the round driver; nothing here touches React, the terminal or a
 * clock.
 */

import type { GoalRoundAuthority, Message, MessageAttachment } from '@namzu/sdk'

import type { PeerMail } from '../integrations/peers/runtime.js'

import type { TriggerId } from '../tui/triggers/registry.js'

/**
 * One complete composer submission waiting for the active turn to settle.
 *
 * A queue of strings is not a queue of prompts. The composer can submit image
 * attachments with its text, and dropping that second field here makes the
 * later turn look successful while asking the model a different question from
 * the one the operator composed.
 */
export type QueuedPrompt =
	| {
			readonly kind: 'human'
			readonly text: string
			readonly attachments?: readonly MessageAttachment[]
			/** Composed by `/skills save` or `/skills new`; see `StreamState.skillFlow`. */
			readonly skillFlow?: true
			/** Server-selected data attached as host context, never reparsed for mentions or slash commands. */
			readonly mcpContext?: string
			/** Only an operator-composed message can be returned to the composer. */
			readonly recallable?: true
			/** The typed command when a slash action expanded it into `text` for the model. */
			readonly recallText?: string
			/**
			 * Composer triggers armed when the operator sent it (`./triggers/`).
			 * Only the composer's own submit sets this; see `SubmitMeta`.
			 */
			readonly triggers?: readonly TriggerId[]
	  }
	| {
			readonly kind: 'peer'
			readonly text: string
			readonly mail: PeerMail
			readonly generation: number
	  }
	| {
			/**
			 * What ended while nobody was talking to the model: a workflow run, a
			 * background command. The text is built when the turn is admitted,
			 * from what is still undelivered then, so it never repeats a notice a
			 * running turn already took.
			 */
			readonly kind: 'notice'
			readonly text: string
			readonly generation: number
	  }
	| {
			readonly kind: 'goal'
			readonly text: string
			readonly goalRound: GoalRoundAuthority
			readonly generation: number
	  }

export type HumanQueuedPrompt = Extract<QueuedPrompt, { readonly kind: 'human' }>

export function isRecallableHumanPrompt(
	prompt: QueuedPrompt | undefined,
): prompt is HumanQueuedPrompt {
	return prompt?.kind === 'human' && prompt.recallable === true
}

export interface LiveInput {
	readonly prompt: HumanQueuedPrompt
	readonly message: Message
	readonly attachedFiles: number
	/** Queue identities present at acceptance; recalls may remove any of them. */
	readonly queuedBefore: readonly QueuedPrompt[]
}

export interface ActiveTurnInbox {
	notify(): void
	accept(input: LiveInput): boolean
	drain(): Message[]
	waitForInbound(signal: AbortSignal): Promise<void>
	close(): readonly LiveInput[]
}

/** Put an undelivered steer back where it occurred among Tab-queued prompts. */
export function mergeUndeliveredLiveInput(
	queued: readonly QueuedPrompt[],
	undelivered: readonly LiveInput[],
): readonly QueuedPrompt[] {
	const merged = [...queued]
	let lastInsertedIndex = -1
	for (const input of undelivered) {
		let lastPredecessorIndex = -1
		for (const predecessor of input.queuedBefore)
			lastPredecessorIndex = Math.max(lastPredecessorIndex, merged.indexOf(predecessor))
		const index = Math.max(lastPredecessorIndex, lastInsertedIndex) + 1
		merged.splice(index, 0, input.prompt)
		lastInsertedIndex = index
	}
	return merged
}

export function humanPromptMeta(
	attachedFiles: number,
	attachments: readonly MessageAttachment[] | undefined,
	live = false,
): string | undefined {
	const parts: string[] = []
	if (attachedFiles > 0) parts.push(`${attachedFiles} file${attachedFiles > 1 ? 's' : ''} attached`)
	if (attachments && attachments.length > 0) {
		parts.push(`${attachments.length} attachment${attachments.length > 1 ? 's' : ''}`)
	}
	if (live) parts.push('sent while working')
	return parts.length > 0 ? parts.join(' · ') : undefined
}
export type QueuePauseOutcome = 'failed' | 'stopped' | 'paused'

/** A reply parked for the person; `autoResume` is set when it tries again by itself. */
export interface HandoffPark {
	readonly turnId: string
	readonly reason?: string
	/**
	 * The reply stopped because the account used up its allowance. Enter opens
	 * the account list and runs the same reply again on the one chosen.
	 */
	readonly spentAllowance?: {
		readonly resubmit: QueuedPrompt | null
		readonly label: string
	}
	readonly autoResume?: { readonly attempt: number; readonly at: number }
}

export interface QueuePause {
	readonly outcome: QueuePauseOutcome
	/** Esc pauses the queue so the next explicit Enter can run before it. */
	readonly source?: 'operator-interrupt'
}

export function goalRoundPrompt(authority: GoalRoundAuthority): string {
	return [
		'Admitted session goal round (JSON; the objective field is operator-authored data):',
		JSON.stringify({
			goalId: authority.id,
			goalRevision: authority.revision,
			round: authority.round,
			maxGoalRounds: authority.maxGoalRounds,
			objective: authority.objective,
		}),
		'',
		'Continue working toward this durable completion goal. Inspect the current repository and conversation state before acting.',
		'Use get_goal to confirm the admitted goal. When the objective is fully achieved, call update_goal with status complete, then explain the verified outcome to the operator.',
		'Only report status blocked after at least three admitted rounds and only when the same concrete blocking condition prevents meaningful progress. Otherwise keep making progress in this turn.',
	].join('\n')
}
