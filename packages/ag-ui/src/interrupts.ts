import type { Interrupt, ResumeEntry } from '@ag-ui/core'
import type {
	HITLDecisionRequest,
	HITLResumeDecision,
	ToolCallSummary,
	ToolHandoff,
	ToolModification,
	UserQuestionData,
} from '@namzu/sdk'

/**
 * What an interrupt asks for.
 *
 * `frontend_tool` is not an interrupt on the wire: it records a call to a
 * client-declared tool the run left unanswered. The client answers it with a
 * `tool` message on the next run, never with a resume entry.
 */
export type AGUIInterruptKind =
	| 'tool_approval'
	| 'question'
	| 'frontend_tool'
	| 'handoff'
	| 'plan_approval'
	| 'checkpoint'
	| 'paused'

export type AGUIInterruptStatus = 'open' | 'resolved' | 'expired'

/**
 * The host's record of one interrupt: what the client was asked, and the
 * native turn and checkpoint the answer continues.
 *
 * The `id` is minted by the adapter and is the only thing the client sees.
 * A resume entry's `interruptId` is used to look a record up and nothing
 * else: the session, turn and checkpoint it continues come from here.
 */
export interface AGUIInterruptRecord {
	readonly id: string
	readonly kind: AGUIInterruptKind
	readonly status: AGUIInterruptStatus
	/**
	 * `checkpoint`: the native turn paused (`turn_paused`) and is continued
	 * from `checkpointId` by `resumeSession`. `live`: the turn is waiting
	 * inside a tool, in the process that raised the interrupt, and the answer
	 * is handed to that tool.
	 */
	readonly delivery: 'live' | 'checkpoint'
	readonly threadId: string
	/** The AG-UI run that ended with this interrupt, as the client named it. */
	readonly runId: string
	/**
	 * Minted once per interrupted run: every record of one run shares it, and
	 * a resume has to answer all of them.
	 */
	readonly group: string
	readonly sessionId: string
	readonly turnId: string
	readonly checkpointId: string
	/** The native tool call an approval, question or frontend call belongs to. */
	readonly toolCallId?: string
	readonly toolName?: string
	/** The park id a question or frontend call waits under. */
	readonly questionId?: string
	/** The option ids a question offered. */
	readonly options?: readonly string[]
	readonly multiSelect?: boolean
	readonly allowFreeText?: boolean
	/** An approval of this call is also asked to confirm it may leave the sandbox. */
	readonly sandboxEscape?: boolean
	/** Every call of the reviewed batch an approval belongs to. */
	readonly batch?: readonly string[]
	/** The calls of that batch the authorization gate refused. */
	readonly gateDenied?: readonly string[]
	/** Epoch ms. */
	readonly createdAt: number
	/** Epoch ms after which the interrupt can no longer be answered, only cancelled. */
	readonly expiresAt?: number
	/** What the client was sent, so it can be sent again. Absent for a frontend call. */
	readonly interrupt?: Interrupt
}

/**
 * Where the adapter keeps interrupt records between runs.
 *
 * The default is in memory, per adapter. A host whose threads must survive a
 * restart supplies a store backed by its own database; `settle` must then be
 * atomic, because it is what makes a resume apply exactly once.
 */
export interface AGUIInterruptStore {
	put(records: readonly AGUIInterruptRecord[]): Promise<void>
	get(id: string): Promise<AGUIInterruptRecord | undefined>
	/** Every record on the thread whose status is `open`. */
	listOpen(threadId: string): Promise<readonly AGUIInterruptRecord[]>
	/**
	 * Move every listed record from `open` to `status`, or none of them.
	 * Returns false when any of them was not open, which is how a second
	 * resume of the same interrupt loses the race to the first.
	 */
	settle(ids: readonly string[], status: 'resolved' | 'expired'): Promise<boolean>
	/**
	 * Return records a resume settled `resolved` to `open`, because the
	 * native turn refused the answer before acting on it: the client can
	 * answer the same interrupts again.
	 */
	reopen(ids: readonly string[]): Promise<void>
}

export interface InMemoryAGUIInterruptStoreOptions {
	/**
	 * Settled records kept, oldest dropped first. Defaults to 10,000. Open
	 * records are never dropped: each is a turn still waiting for its client.
	 */
	readonly maxRecords?: number
}

/** The default store: a bounded map in this process. */
export class InMemoryAGUIInterruptStore implements AGUIInterruptStore {
	private readonly records = new Map<string, AGUIInterruptRecord>()
	private readonly maxRecords: number

	constructor(options: InMemoryAGUIInterruptStoreOptions = {}) {
		const max = options.maxRecords ?? 10_000
		if (!Number.isSafeInteger(max) || max < 1)
			throw new RangeError('maxRecords must be a positive safe integer')
		this.maxRecords = max
	}

	async put(records: readonly AGUIInterruptRecord[]): Promise<void> {
		for (const record of records) {
			if (this.records.has(record.id)) throw new Error(`Interrupt ${record.id} already exists`)
		}
		for (const record of records) this.records.set(record.id, { ...record })
		this.evict()
	}

	async get(id: string): Promise<AGUIInterruptRecord | undefined> {
		const record = this.records.get(id)
		return record ? { ...record } : undefined
	}

	async listOpen(threadId: string): Promise<readonly AGUIInterruptRecord[]> {
		return [...this.records.values()]
			.filter((record) => record.threadId === threadId && record.status === 'open')
			.map((record) => ({ ...record }))
	}

	async settle(ids: readonly string[], status: 'resolved' | 'expired'): Promise<boolean> {
		const found = ids.map((id) => this.records.get(id))
		if (found.some((record) => record?.status !== 'open')) return false
		for (const record of found as AGUIInterruptRecord[]) {
			this.records.set(record.id, { ...record, status })
		}
		this.evict()
		return true
	}

	async reopen(ids: readonly string[]): Promise<void> {
		for (const id of ids) {
			const record = this.records.get(id)
			if (record?.status === 'resolved') this.records.set(id, { ...record, status: 'open' })
		}
	}

	private evict(): void {
		// Settled records exist only to tell a late duplicate apart from an
		// unknown id; an open one is a turn waiting for its client, and
		// dropping it would leave that turn unanswerable.
		let settled = 0
		for (const record of this.records.values()) if (record.status !== 'open') settled++
		for (const [id, record] of this.records) {
			if (settled <= this.maxRecords) return
			if (record.status === 'open') continue
			this.records.delete(id)
			settled--
		}
	}
}

/** A refusal to continue a thread, reported as `RUN_ERROR`. */
export class AGUIResumeError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'AGUIResumeError'
	}
}

// ─── the wire ─────────────────────────────────────────────────────────────

const APPROVAL_PROPERTIES = {
	approved: { type: 'boolean', description: 'Run the call (true) or refuse it (false).' },
	editedArgs: {
		type: 'object',
		description: 'Full replacement of the tool arguments. Not merged.',
	},
	reason: { type: 'string', description: 'Why the call was refused. The model reads it.' },
} as const

const CONFIRMATION_SCHEMA = {
	type: 'object',
	properties: {
		approved: { type: 'boolean' },
		feedback: { type: 'string', description: 'What the agent should know about the decision.' },
	},
	required: ['approved'],
} as const

export function approvalInterrupt(record: AGUIInterruptRecord, call: ToolCallSummary): Interrupt {
	const leavesSandbox = call.escalation?.sandboxEscape === true
	const outsidePaths = call.escalation?.outsidePaths ?? []
	const notes = [
		leavesSandbox ? 'It asks to run outside the sandbox.' : undefined,
		outsidePaths.length ? `It reaches ${outsidePaths.join(', ')}.` : undefined,
	].filter((note): note is string => note !== undefined)
	return withExpiry(record, {
		id: record.id,
		reason: 'tool_call',
		toolCallId: call.id,
		message: [`Approve the ${call.name} call?`, ...notes].join(' '),
		responseSchema: {
			type: 'object',
			properties: {
				...APPROVAL_PROPERTIES,
				...(leavesSandbox
					? {
							confirmSandboxEscape: {
								type: 'boolean',
								description: 'Also let this call run outside the sandbox.',
							},
						}
					: {}),
			},
			required: ['approved'],
		},
		metadata: {
			namzu: {
				kind: 'tool_approval',
				toolName: call.name,
				input: call.input,
				destructive: call.isDestructive,
				...(leavesSandbox ? { sandboxEscape: true } : {}),
				...(outsidePaths.length ? { outsidePaths: [...outsidePaths] } : {}),
			},
		},
	})
}

export function questionInterrupt(
	record: AGUIInterruptRecord,
	question: UserQuestionData,
	toolCallId: string | undefined,
): Interrupt {
	const ids = question.options.map((option) => option.id)
	return withExpiry(record, {
		id: record.id,
		reason: 'input_required',
		...(toolCallId ? { toolCallId } : {}),
		message: question.question,
		responseSchema: {
			type: 'object',
			properties: {
				...(ids.length > 0
					? {
							selected: {
								type: 'array',
								items: { type: 'string', enum: ids },
								uniqueItems: true,
								maxItems: question.multiSelect ? ids.length : 1,
								description: 'The ids of the options chosen.',
							},
						}
					: {}),
				...(question.allowFreeText
					? { text: { type: 'string', description: 'An answer in the user’s own words.' } }
					: {}),
			},
		},
		metadata: {
			namzu: {
				kind: 'question',
				...(question.header !== undefined ? { header: question.header } : {}),
				options: question.options.map((option) => ({
					id: option.id,
					label: option.label,
					...(option.description !== undefined ? { description: option.description } : {}),
				})),
				multiSelect: question.multiSelect,
				allowFreeText: question.allowFreeText,
			},
		},
	})
}

export function handoffInterrupt(record: AGUIInterruptRecord, handoff: ToolHandoff): Interrupt {
	return withExpiry(record, {
		id: record.id,
		reason: 'namzu:handoff',
		message: handoff.reason,
		metadata: {
			namzu: {
				kind: 'handoff',
				...(handoff.detail ? { detail: { ...handoff.detail } } : {}),
			},
		},
	})
}

export function pausedInterrupt(
	record: AGUIInterruptRecord,
	reason: string,
	retryable?: boolean,
): Interrupt {
	return withExpiry(record, {
		id: record.id,
		reason: 'namzu:paused',
		message: reason,
		metadata: {
			namzu: { kind: 'paused', ...(retryable !== undefined ? { retryable } : {}) },
		},
	})
}

export function confirmationInterrupt(
	record: AGUIInterruptRecord,
	request: Extract<HITLDecisionRequest, { type: 'plan_approval' | 'iteration_checkpoint' }>,
): Interrupt {
	if (request.type === 'plan_approval') {
		const { plan } = request
		return withExpiry(record, {
			id: record.id,
			reason: 'confirmation',
			message: `Approve the plan “${plan.title}”?`,
			responseSchema: CONFIRMATION_SCHEMA,
			metadata: {
				namzu: {
					kind: 'plan_approval',
					plan: {
						title: plan.title,
						...(plan.summary !== undefined ? { summary: plan.summary } : {}),
						steps: plan.steps.map((step) => ({
							id: step.id,
							description: step.description,
							...(step.toolName !== undefined ? { toolName: step.toolName } : {}),
							...(step.agentId !== undefined ? { agentId: step.agentId } : {}),
						})),
					},
				},
			},
		})
	}
	return withExpiry(record, {
		id: record.id,
		reason: 'confirmation',
		message: `Continue after iteration ${request.summary.iteration}?`,
		responseSchema: CONFIRMATION_SCHEMA,
		metadata: {
			namzu: {
				kind: 'checkpoint',
				iteration: request.summary.iteration,
				...(request.summary.lastAssistantMessage !== undefined
					? { lastAssistantMessage: request.summary.lastAssistantMessage }
					: {}),
			},
		},
	})
}

function withExpiry(record: AGUIInterruptRecord, interrupt: Interrupt): Interrupt {
	return record.expiresAt === undefined
		? interrupt
		: { ...interrupt, expiresAt: new Date(record.expiresAt).toISOString() }
}

// ─── reading the answers ──────────────────────────────────────────────────

/** One resume entry, checked against the interrupt it answers. */
export type AGUIAnswer =
	| {
			readonly kind: 'approval'
			readonly approved: boolean
			readonly editedArgs?: Record<string, unknown>
			readonly reason?: string
			readonly confirmSandboxEscape: boolean
	  }
	| { readonly kind: 'answer'; readonly selected: readonly string[]; readonly text?: string }
	| { readonly kind: 'continue' }
	| { readonly kind: 'confirm'; readonly approved: boolean; readonly feedback?: string }
	| { readonly kind: 'cancel' }

/**
 * The records a resume answers, each with its answer, after every check the
 * adapter can make without touching the kernel: every id known on this
 * thread, open, unexpired, answered once, all of one interrupted run, that
 * run covered completely, and every payload in the shape its interrupt asked
 * for.
 */
export async function readResume(
	store: AGUIInterruptStore,
	threadId: string,
	entries: readonly ResumeEntry[],
	now: number,
): Promise<{ readonly records: readonly AGUIInterruptRecord[]; readonly answers: AGUIAnswer[] }> {
	const seen = new Set<string>()
	const records: AGUIInterruptRecord[] = []
	for (const entry of entries) {
		if (seen.has(entry.interruptId))
			throw new AGUIResumeError(
				'AGUI_RESUME_INVALID',
				`Interrupt ${entry.interruptId} is answered more than once in this resume.`,
			)
		seen.add(entry.interruptId)
		const record = await store.get(entry.interruptId)
		// A record on another thread reads exactly like no record: which ids
		// exist elsewhere is not this caller's business.
		if (!record || record.threadId !== threadId || record.kind === 'frontend_tool')
			throw new AGUIResumeError(
				'AGUI_INTERRUPT_UNKNOWN',
				`No interrupt ${entry.interruptId} was raised on this thread.`,
			)
		if (record.status === 'resolved')
			throw new AGUIResumeError(
				'AGUI_INTERRUPT_RESOLVED',
				`Interrupt ${entry.interruptId} has already been answered.`,
			)
		const expired =
			record.status === 'expired' || (record.expiresAt !== undefined && now >= record.expiresAt)
		if (expired && entry.status !== 'cancelled')
			throw new AGUIResumeError(
				'AGUI_INTERRUPT_EXPIRED',
				`Interrupt ${entry.interruptId} expired; it can only be cancelled.`,
			)
		records.push(record)
	}
	const groups = new Set(records.map((record) => record.group))
	if (groups.size > 1)
		throw new AGUIResumeError(
			'AGUI_RESUME_INVALID',
			'A resume answers the interrupts of one interrupted run.',
		)
	const open = (await store.listOpen(threadId)).filter(
		(record) => record.kind !== 'frontend_tool' && record.group === records[0]?.group,
	)
	const uncovered = open.filter((record) => !seen.has(record.id))
	if (uncovered.length > 0)
		throw new AGUIResumeError(
			'AGUI_RESUME_INCOMPLETE',
			`The resume does not answer ${uncovered.map((record) => record.id).join(', ')}.`,
		)
	const answers = entries.map((entry, index) =>
		readAnswer(records[index] as AGUIInterruptRecord, entry),
	)
	return { records, answers }
}

function readAnswer(record: AGUIInterruptRecord, entry: ResumeEntry): AGUIAnswer {
	if (entry.status === 'cancelled') return { kind: 'cancel' }
	const invalid = (why: string): never => {
		throw new AGUIResumeError(
			'AGUI_RESUME_PAYLOAD_INVALID',
			`The answer to interrupt ${record.id} ${why}.`,
		)
	}
	const payload: unknown = entry.payload
	switch (record.kind) {
		case 'tool_approval': {
			if (!isPlainObject(payload)) return invalid('must be an object with a boolean `approved`')
			if (typeof payload.approved !== 'boolean') return invalid('needs a boolean `approved`')
			if (payload.editedArgs !== undefined && !isPlainObject(payload.editedArgs))
				return invalid('has `editedArgs` that is not an object')
			if (payload.reason !== undefined && typeof payload.reason !== 'string')
				return invalid('has a `reason` that is not a string')
			if (
				payload.confirmSandboxEscape !== undefined &&
				typeof payload.confirmSandboxEscape !== 'boolean'
			)
				return invalid('has a `confirmSandboxEscape` that is not a boolean')
			return {
				kind: 'approval',
				approved: payload.approved,
				...(payload.editedArgs !== undefined
					? { editedArgs: payload.editedArgs as Record<string, unknown> }
					: {}),
				...(typeof payload.reason === 'string' && payload.reason.trim()
					? { reason: payload.reason }
					: {}),
				confirmSandboxEscape: payload.confirmSandboxEscape === true,
			}
		}
		case 'question': {
			// A bare string is an answer in the user's own words.
			const value = typeof payload === 'string' ? { text: payload } : payload
			if (!isPlainObject(value)) return invalid('must be an object with `selected` and/or `text`')
			const selected = value.selected ?? []
			if (!Array.isArray(selected) || selected.some((item) => typeof item !== 'string'))
				return invalid('has `selected` that is not a list of option ids')
			const offered = new Set(record.options ?? [])
			if (selected.some((item) => !offered.has(item)))
				return invalid('selects an option the question did not offer')
			if (new Set(selected).size !== selected.length) return invalid('selects an option twice')
			if (!record.multiSelect && selected.length > 1) return invalid('selects more than one option')
			if (value.text !== undefined && typeof value.text !== 'string')
				return invalid('has `text` that is not a string')
			if (typeof value.text === 'string' && value.text.length > 0 && !record.allowFreeText)
				return invalid('answers in free text, which the question does not accept')
			return {
				kind: 'answer',
				selected: selected as string[],
				...(typeof value.text === 'string' && value.text.length > 0 ? { text: value.text } : {}),
			}
		}
		case 'plan_approval':
		case 'checkpoint': {
			if (!isPlainObject(payload) || typeof payload.approved !== 'boolean')
				return invalid('needs a boolean `approved`')
			if (payload.feedback !== undefined && typeof payload.feedback !== 'string')
				return invalid('has `feedback` that is not a string')
			return {
				kind: 'confirm',
				approved: payload.approved,
				...(typeof payload.feedback === 'string' && payload.feedback.trim()
					? { feedback: payload.feedback }
					: {}),
			}
		}
		case 'handoff':
		case 'paused':
			// Nothing to validate: resolving says "I did what was asked, go on".
			return { kind: 'continue' }
		case 'frontend_tool':
			return invalid('is a tool result, which arrives as a `tool` message')
	}
}

/**
 * The native decision a set of tool approvals adds up to.
 *
 * Calls nobody was asked about were ones the review policy would have let
 * through. They stay approved: `modify_tools` approves every call it does
 * not name. A refusal's own words survive only when the whole batch is
 * refused, because `modify_tools` carries no per-call feedback.
 */
export function approvalDecision(
	records: readonly AGUIInterruptRecord[],
	answers: readonly AGUIAnswer[],
	batch: readonly string[],
): HITLResumeDecision {
	const modifications: ToolModification[] = []
	const confirmed: string[] = []
	const reasons: string[] = []
	let denied = 0
	for (const [index, record] of records.entries()) {
		const answer = answers[index]
		const callId = record.toolCallId as string
		if (answer?.kind !== 'approval' || !answer.approved) {
			denied++
			if (answer?.kind === 'approval' && answer.reason) reasons.push(answer.reason)
			modifications.push({ toolCallId: callId, action: 'deny' })
			continue
		}
		if (record.sandboxEscape && answer.confirmSandboxEscape) confirmed.push(callId)
		if (answer.editedArgs !== undefined)
			modifications.push({ toolCallId: callId, action: 'modify', modifiedInput: answer.editedArgs })
	}
	if (denied > 0 && denied === batch.length) {
		return {
			action: 'reject_tools',
			feedback: reasons.join('\n') || 'The user declined these tool calls.',
		}
	}
	if (modifications.length === 0) {
		return {
			action: 'approve_tools',
			...(confirmed.length ? { confirmedEscalations: confirmed } : {}),
		}
	}
	return {
		action: 'modify_tools',
		modifications,
		...(confirmed.length ? { confirmedEscalations: confirmed } : {}),
	}
}

/** The native answer to a question, or to a frontend call's result park. */
export function questionDecision(
	record: AGUIInterruptRecord,
	answer: AGUIAnswer,
): HITLResumeDecision {
	const questionId = record.questionId as string
	if (answer.kind === 'answer') {
		return {
			action: 'answer_question',
			questionId,
			selectedOptionIds: [...answer.selected],
			...(answer.text !== undefined ? { freeText: answer.text } : {}),
		}
	}
	// Cancelled: an answer that selects nothing and says nothing, which the
	// asking tool reports as "the user did not answer" — never as consent.
	return { action: 'answer_question', questionId, selectedOptionIds: [] }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
