import type { CheckpointId, HITLResumeDecision, UserQuestionData } from '../../types/hitl/index.js'

/**
 * Durability for a question raised from inside a tool.
 *
 * `ask_user_question` parked through the raw handler with a synthetic
 * `cp_question_<toolUseId>` id that was never written anywhere. The
 * checkpoint therefore did not exist: nothing on disk said a human owed
 * this run an answer, `findPendingCheckpoint` could never return it, and a
 * remote host could not even OBSERVE the question except through the
 * in-process callback. Kill the process while somebody is looking at the
 * question card and the answer can never be applied — the restore path
 * strips the whole assistant turn, discarding work that sibling tools in
 * the same batch had already finished, and re-bills the turn.
 *
 * Two halves, and the second is the one that was hard:
 *
 *  1. **Record.** Write a real checkpoint through the manager, so the park
 *     is durable and visible on every surface a tool-review park is.
 *  2. **Re-enter.** On resume, deliver the answer to the tool that asked
 *     rather than re-asking. The batch is re-executed — which is how the
 *     asking tool gets re-entered at all — and this registry is what makes
 *     that re-entry return the recorded answer instead of parking again.
 *     Siblings that already completed are answered from the transcript, so
 *     re-execution costs nothing beyond the one tool that was waiting.
 */
export interface QuestionParkRecorder {
	/**
	 * Record the park and return the checkpoint id it was written under, or
	 * `null` when it could not be recorded.
	 *
	 * `null` rather than a throw: an unrecorded park is a lost cross-process
	 * handoff, not a reason to fail the tool. The in-process await is still
	 * perfectly valid, and taking the run down would turn a durability
	 * shortfall into an outage.
	 */
	record(question: UserQuestionData): Promise<CheckpointId | null>
	/** Clear the park once an answer arrives, so a queue stops serving it. */
	resolve(checkpointId: CheckpointId, decision: HITLResumeDecision): Promise<void>
}

/**
 * A recorder whose backing store is attached later.
 *
 * The tool that asks is built before the run exists — an agent constructs
 * its tool registry, and only then hands it to `query()`, which is where
 * the checkpoint manager is created. Binding late is what lets the same
 * tool instance be durable inside a run and inert outside one, without the
 * tool builder needing to know about checkpoints at all.
 *
 * Unbound, `record` returns `null` and `resolve` is a no-op, which is
 * exactly the previous behaviour: the in-process await still works, only
 * the cross-process handoff is missing.
 */
export class QuestionParkBinding implements QuestionParkRecorder {
	private backing?: QuestionParkRecorder

	bind(recorder: QuestionParkRecorder): void {
		this.backing = recorder
	}

	/** Detach when the run settles, so a later run cannot write into it. */
	unbind(): void {
		this.backing = undefined
	}

	async record(question: UserQuestionData): Promise<CheckpointId | null> {
		return (await this.backing?.record(question)) ?? null
	}

	async resolve(checkpointId: CheckpointId, decision: HITLResumeDecision): Promise<void> {
		await this.backing?.resolve(checkpointId, decision)
	}
}

/**
 * Answers carried into a resumed run, keyed by the `questionId` of the
 * tool call that asked.
 *
 * Consulted before the park handler, so a re-entered `ask_user_question`
 * returns the recorded answer rather than parking a second time — which
 * would ask the user something they have already answered, and in a
 * headless resume would deadlock or auto-answer with the no-consent
 * sentinel.
 *
 * Each answer is consumed once. A tool that somehow asks the same question
 * twice in one resumed run is asking a genuinely new question the second
 * time, and answering it from a stale record would be fabricating consent.
 */
export class PendingAnswers {
	private readonly answers = new Map<string, HITLResumeDecision>()

	static from(decision: HITLResumeDecision | undefined): PendingAnswers {
		const pending = new PendingAnswers()
		if (decision?.action === 'answer_question' && decision.questionId !== undefined) {
			pending.set(decision.questionId, decision)
		}
		return pending
	}

	set(questionId: string, decision: HITLResumeDecision): void {
		this.answers.set(questionId, decision)
	}

	/** Take the answer for this question, removing it. */
	take(questionId: string): HITLResumeDecision | undefined {
		const answer = this.answers.get(questionId)
		if (answer !== undefined) this.answers.delete(questionId)
		return answer
	}

	/** Every recorded answer, for copying between instances. */
	entries(): Iterable<[string, HITLResumeDecision]> {
		return this.answers.entries()
	}

	get size(): number {
		return this.answers.size
	}
}
