import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
	type HarnessProtectionPlan,
	normalizeHarnessProtection,
} from '../eval/harness-protection.js'
import {
	type HarnessReview,
	type HarnessVerificationBatch,
	reviewHarnessCandidate,
} from '../eval/harness-verification.js'
import type { DiskResidentAgenda } from '../manager/resident/agenda.js'
import { ResidentConflictError } from '../manager/resident/store.js'
import {
	LearningLeakError,
	type LearningLeakFinding,
	type LearningLeakGuard,
	type LearningLeakSubject,
	assertNoLearningLeak,
} from './leak-tripwire.js'
import {
	type LearningEvidence,
	type LearningSkillCandidate,
	hashLearningSkill,
	learningEvidenceSchema,
	normalizeLearningSkill,
	promoteLearningSkill,
} from './skill.js'

/** @experimental One explicitly requested experiment; callbacks own inference and evaluation. */
export type LearningStage = 'explore' | 'generate' | 'verification' | 'confirmation'

const receiptSchema = z.object({
	/** The session and turn of the execution this usage belongs to; one receipt per turn. */
	sessionId: z.string().uuid(),
	turnId: z.string().uuid(),
	tokens: z.number().int().nonnegative().safe().nullable(),
	costUsd: z.number().nonnegative().finite().nullable(),
})

/** @experimental One non-overlapping execution's usage, including its retries. Null is unknown. */
export type LearningReceipt = Readonly<z.infer<typeof receiptSchema>>

/** @experimental Recorded values are lower bounds when a receipt or stage is incomplete. */
export interface LearningConsumption {
	readonly tokens: number
	readonly costUsd: number
	readonly receipts: number
	readonly unknownTokens: number
	readonly unknownCosts: number
	readonly unfinishedStages: number
}

/** @experimental Append in sequence to host-owned durable storage before acknowledging. */
export interface LearningCycleEvent {
	readonly cycleId: string
	readonly sequence: number
	readonly kind:
		| 'started'
		| 'stage-started'
		| 'stage-finished'
		| 'usage'
		| 'exploration'
		| 'candidate'
		| 'evaluation'
		| 'activation-requested'
		| 'finished'
	readonly stage?: LearningStage
	readonly data: Readonly<Record<string, unknown>>
}

/** @experimental Use this stage's signal for every owned execution; await every usage append. */
export interface LearningCycleContext {
	readonly cycleId: string
	readonly stage: LearningStage
	readonly signal: AbortSignal
	/** Planning allowance, not a reservation or a cap on a callback's in-flight work. */
	readonly remainingUnits: number
	recordUsage(receipt: LearningReceipt): Promise<void>
}

/** @experimental Original failure and active baseline; never contains confirmation tasks. */
export interface LearningExplorationContext extends LearningCycleContext {
	readonly skillName: string
	/** Admitted by the host before generation; cannot be changed by a candidate. */
	readonly purpose?: 'task' | 'exploration'
	readonly failure: Readonly<{ evidence: LearningEvidence; trace: string }>
	readonly baseline: LearningSkillCandidate | null
}

/** @experimental Host-retained environment observations, not a model's claim of success. */
export interface LearningExploration {
	readonly evidence: LearningEvidence
	readonly trace: string
}

/** @experimental Generation sees completed exploration, never held-out evaluation cases. */
export interface LearningGenerationContext extends LearningExplorationContext {
	readonly exploration?: Readonly<LearningExploration>
}

/** @experimental The host supplies independently scored, retained traces for these exact revisions. */
export interface LearningEvaluationContext extends LearningCycleContext {
	readonly baseline: LearningSkillCandidate | null
	readonly candidate: LearningSkillCandidate
	readonly baselineRevision: string
	readonly candidateRevision: string
}

/** @experimental No provider, default background loop or executable-code activation is installed. */
export interface LearningCycleOptions {
	/** Omitted means task guidance. Explicitly select exploration to improve an explorer policy. */
	readonly purpose?: 'task' | 'exploration'
	/** Fixed before generation; both rounds must preserve every named task. */
	readonly protection: HarnessProtectionPlan
	readonly agenda: Pick<DiskResidentAgenda, 'read' | 'promoteSkill'>
	readonly skillName: string
	readonly failure: { readonly evidence: LearningEvidence; readonly trace: string }
	readonly parentCycleId?: string
	/**
	 * Evaluator-side material to keep out of the evidence and the guidance built
	 * from it. The built-in markers and secret shapes always apply. A hit refuses
	 * the cycle as a leak (see `LearningCycleResult.leak`), before anything is built.
	 */
	readonly leakGuard?: LearningLeakGuard
	readonly signal: AbortSignal
	/** Stops subsequent stages/activation after observed excess; callbacks enforce in-flight limits. */
	readonly resources: { readonly unit: 'tokens' | 'usd'; readonly maxUnits: number }
	readonly record: (event: LearningCycleEvent) => Promise<void>
	/** Optional active tool exploration before synthesis; the host retains actual observations. */
	readonly explore?: (context: LearningExplorationContext) => Promise<{
		readonly observations: LearningExploration
		readonly usageComplete: boolean
	}>
	readonly generate: (context: LearningGenerationContext) => Promise<{
		readonly candidate: LearningSkillCandidate
		/** All executions, including failures and side calls, have supplied receipts. */
		readonly usageComplete: boolean
	}>
	readonly evaluate: (context: LearningEvaluationContext) => Promise<{
		readonly batch: HarnessVerificationBatch
		readonly usageComplete: boolean
	}>
}

/** @experimental An ambiguous activation must be inspected, never automatically replayed. */
export interface LearningCycleResult {
	readonly cycleId: string
	readonly status:
		| 'activated'
		| 'rejected'
		| 'inconclusive'
		| 'conflict'
		| 'cancelled'
		| 'failed'
		| 'activation-unknown'
	readonly reason: string
	readonly candidate?: LearningSkillCandidate
	readonly candidateRevision?: string
	readonly baselineRevision?: string
	readonly agendaRevision?: number
	readonly review?: HarnessReview
	/** Present when the cycle was refused as a leak: where it was seen, never the text. */
	readonly leak?: readonly LearningLeakFinding[]
	readonly consumption: LearningConsumption
	readonly auditComplete: boolean
}

/**
 * @experimental Generate one candidate, independently verify and confirm it, then
 * activate through the existing exact-revision transaction. No internal inference
 * loop, retry or model-generated success claim replaces the host's evaluator.
 */
export async function runLearningCycle(
	options: LearningCycleOptions,
): Promise<LearningCycleResult> {
	const protection = normalizeHarnessProtection(options.protection)
	const purpose = z.enum(['task', 'exploration']).parse(options.purpose ?? 'task')
	const purposeContext = options.purpose === undefined ? {} : { purpose }
	const skillName = z
		.string()
		.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
		.parse(options.skillName)
	const failure = Object.freeze({
		evidence: Object.freeze(learningEvidenceSchema.parse(options.failure.evidence)),
		trace: z.string().trim().min(1).max(32_000).parse(options.failure.trace),
	})
	const resources = z
		.object({ unit: z.enum(['tokens', 'usd']), maxUnits: z.number().positive().finite() })
		.parse(options.resources)
	const parentCycleId =
		options.parentCycleId === undefined ? undefined : z.string().uuid().parse(options.parentCycleId)
	const cycleId = randomUUID()
	const receipts = new Map<string, LearningReceipt>()
	let sequence = 0
	let pending = Promise.resolve()
	let auditComplete = true
	let unfinishedStages = 0
	let candidate: LearningSkillCandidate | undefined
	let candidateRevision: string | undefined
	let baselineRevision: string | undefined
	let review: HarnessReview | undefined
	let activatedRevision: number | undefined
	let activationRequested = false
	let leak: readonly LearningLeakFinding[] | undefined
	const usage = (): LearningConsumption => ({
		tokens: [...receipts.values()].reduce((n, r) => n + (r.tokens ?? 0), 0),
		costUsd: [...receipts.values()].reduce((n, r) => n + (r.costUsd ?? 0), 0),
		receipts: receipts.size,
		unknownTokens: [...receipts.values()].filter((r) => r.tokens === null).length,
		unknownCosts: [...receipts.values()].filter((r) => r.costUsd === null).length,
		unfinishedStages,
	})
	const append = (
		kind: LearningCycleEvent['kind'],
		data: Record<string, unknown>,
		stage?: LearningStage,
	) => {
		const event = Object.freeze({
			cycleId,
			sequence: ++sequence,
			kind,
			...(stage ? { stage } : {}),
			data: structuredClone(data),
		})
		pending = pending
			.then(() => options.record(event))
			.catch((error) => {
				auditComplete = false
				throw error
			})
		return pending
	}
	const result = (status: LearningCycleResult['status'], reason: string): LearningCycleResult => ({
		cycleId,
		status,
		reason,
		...(candidate ? { candidate, candidateRevision } : {}),
		...(baselineRevision ? { baselineRevision } : {}),
		...(review ? { review } : {}),
		...(leak ? { leak } : {}),
		...(activatedRevision !== undefined ? { agendaRevision: activatedRevision } : {}),
		consumption: usage(),
		auditComplete,
	})
	const resourceProblem = (needsWork = false): string | null => {
		const measured = usage()
		if (
			unfinishedStages ||
			(resources.unit === 'tokens' ? measured.unknownTokens : measured.unknownCosts)
		)
			return `Incomplete ${resources.unit} evidence prevents further learning stages or activation.`
		if ((resources.unit === 'tokens' ? measured.tokens : measured.costUsd) > resources.maxUnits)
			return 'Recorded experiment consumption exceeds the declared resource allowance.'
		if (
			needsWork &&
			(resources.unit === 'tokens' ? measured.tokens : measured.costUsd) === resources.maxUnits
		)
			return 'The recorded resource allowance is exhausted before the next stage.'
		return null
	}
	const execute = async (): Promise<LearningCycleResult> => {
		options.signal.throwIfAborted()
		const guard = (...subjects: LearningLeakSubject[]) =>
			assertNoLearningLeak(options.leakGuard, subjects)
		guard(
			{
				subject: 'failure.evidence',
				text: `${failure.evidence.key}\n${failure.evidence.source}\n${failure.evidence.reason}`,
			},
			{ subject: 'failure.trace', text: failure.trace },
		)
		const snapshot = structuredClone(await options.agenda.read())
		if (!snapshot) throw new Error('No resident agenda exists for this learning cycle.')
		if (snapshot.paused || snapshot.pursuits.some((p) => p.state.phase === 'running'))
			throw new Error('Resident learning requires an unpaused agenda without running pursuits.')
		const current = snapshot.learning?.skills.find((s) => s.name === skillName)
		if (current && (current.purpose ?? 'task') !== purpose)
			throw new Error(
				'The active skill has a different learning purpose; use a distinct skill name.',
			)
		const baseline = current ? normalizeLearningSkill(current) : null
		baselineRevision = baseline ? hashLearningSkill(baseline) : 'none'
		await append('started', {
			tenantId: snapshot.tenantId,
			agentKey: snapshot.agentKey,
			agendaRevision: snapshot.revision,
			baselineRevision,
			skillName,
			...purposeContext,
			failure,
			resources,
			protection,
			...(options.explore ? { explorationEnabled: true } : {}),
			...(parentCycleId ? { parentCycleId } : {}),
		})
		const check = async () => {
			options.signal.throwIfAborted()
			const latest = await options.agenda.read()
			options.signal.throwIfAborted()
			if (
				!latest ||
				latest.tenantId !== snapshot.tenantId ||
				latest.agentKey !== snapshot.agentKey ||
				latest.revision !== snapshot.revision
			)
				throw new ResidentConflictError()
		}
		const stage = async <T extends { usageComplete: boolean }>(
			name: LearningStage,
			callback: (context: LearningCycleContext) => Promise<T>,
		): Promise<T> => {
			await check()
			await append('stage-started', {}, name)
			await check()
			unfinishedStages++
			let open = true
			let receiptFailure: unknown
			const before = receipts.size
			try {
				const measured = usage()
				const context: LearningCycleContext = Object.freeze({
					cycleId,
					stage: name,
					signal: options.signal,
					remainingUnits: Math.max(
						0,
						resources.maxUnits - (resources.unit === 'tokens' ? measured.tokens : measured.costUsd),
					),
					recordUsage: async (input: LearningReceipt) => {
						try {
							if (!open) throw new Error('A closed learning stage cannot record new usage.')
							const receipt = Object.freeze(receiptSchema.parse(input))
							const id = receipt.turnId.toLowerCase()
							if (receipts.has(id)) throw new Error('Duplicate learning execution receipt.')
							if (receipts.size >= 1024) throw new Error('Learning cycle receipt bound exceeded.')
							const totals = usage()
							if (
								!Number.isSafeInteger(totals.tokens + (receipt.tokens ?? 0)) ||
								!Number.isFinite(totals.costUsd + (receipt.costUsd ?? 0))
							)
								throw new Error('Learning cycle consumption overflow.')
							receipts.set(id, receipt)
							await append('usage', { receipt }, name)
						} catch (error) {
							receiptFailure = error
							throw error
						}
					},
				})
				const value = await callback(context)
				open = false
				await pending
				if (receiptFailure) throw receiptFailure
				options.signal.throwIfAborted()
				if (value.usageComplete === true && receipts.size > before) unfinishedStages--
				await append(
					'stage-finished',
					{
						usageComplete: value.usageComplete === true && receipts.size > before,
						consumption: usage(),
					},
					name,
				)
				return value
			} finally {
				open = false
			}
		}
		let exploration: Readonly<LearningExploration> | undefined
		if (options.explore) {
			const explore = options.explore
			const observed = await stage('explore', (context) =>
				explore(Object.freeze({ ...context, skillName, ...purposeContext, failure, baseline })),
			)
			exploration = Object.freeze({
				evidence: Object.freeze(learningEvidenceSchema.parse(observed.observations.evidence)),
				trace: z.string().trim().min(1).max(32_000).parse(observed.observations.trace),
			})
			guard(
				{
					subject: 'exploration.evidence',
					text: `${exploration.evidence.key}\n${exploration.evidence.source}\n${exploration.evidence.reason}`,
				},
				{ subject: 'exploration.trace', text: exploration.trace },
			)
			await append(
				'exploration',
				{
					observations: exploration,
					digest: createHash('sha256').update(JSON.stringify(exploration)).digest('hex'),
				},
				'explore',
			)
			const problem = resourceProblem(true)
			if (problem) return result('inconclusive', problem)
		}
		const generated = await stage('generate', (context) =>
			options.generate(
				Object.freeze({
					...context,
					skillName,
					...purposeContext,
					failure,
					baseline,
					...(exploration ? { exploration } : {}),
				}),
			),
		)
		const built = normalizeLearningSkill(generated.candidate)
		guard(
			{ subject: 'candidate.name', text: built.name },
			{ subject: 'candidate.description', text: built.description },
			{ subject: 'candidate.body', text: built.body },
			{
				subject: 'candidate.sources',
				text: (built.sources ?? []).map((s) => `${s.key}\n${s.revision}`).join('\n'),
				paths: (built.sources ?? []).map((s) => s.key),
			},
		)
		candidateRevision = hashLearningSkill(generated.candidate)
		candidate = built
		if ((candidate.purpose ?? 'task') !== purpose)
			throw new Error('Generated skill purpose does not match the host-admitted learning purpose.')
		if (candidate.name !== skillName)
			throw new Error('Generated guidance must retain the requested skill name.')
		await append('candidate', { candidate, candidateRevision, baselineRevision })
		if (candidateRevision === baselineRevision)
			return result('rejected', 'Generated guidance is identical to the active baseline.')
		let problem = resourceProblem(true)
		if (problem) return result('inconclusive', problem)
		const evaluate = async (name: 'verification' | 'confirmation') => {
			const measured = await stage(name, (context) =>
				options.evaluate(
					Object.freeze({
						...context,
						baseline,
						candidate: candidate as LearningSkillCandidate,
						baselineRevision: baselineRevision as string,
						candidateRevision: candidateRevision as string,
					}),
				),
			)
			const batch = structuredClone(measured.batch)
			if (
				batch.baselineRevision !== baselineRevision ||
				batch.candidateRevision !== candidateRevision
			)
				throw new Error('Evaluation does not identify the admitted baseline and candidate.')
			if (
				batch.baseline.length > 128 ||
				batch.candidate.length > 128 ||
				batch.attributions.length > 128
			)
				throw new Error('A learning evaluation is bounded to 64 paired tasks.')
			await append(
				'evaluation',
				{
					baselineRevision,
					candidateRevision,
					digest: createHash('sha256').update(JSON.stringify(batch)).digest('hex'),
					baselineTrajectories: batch.baseline.map((t) => t.trajectoryId),
					candidateTrajectories: batch.candidate.map((t) => t.trajectoryId),
				},
				name,
			)
			return batch
		}
		const verification = await evaluate('verification')
		review = reviewHarnessCandidate(verification, undefined, protection)
		problem = resourceProblem(true)
		if (problem) return result('inconclusive', problem)
		if (review.decision === 'reject') return result('rejected', review.reason)
		if (
			review.protection?.verification.status !== 'passed' ||
			review.verification.unresolved.length ||
			review.verification.tasks.length < 5 ||
			review.verification.tasks.some((t) => t.trials !== 2)
		)
			return result('inconclusive', review.reason)
		const confirmation = await evaluate('confirmation')
		review = reviewHarnessCandidate(verification, confirmation, protection)
		problem = resourceProblem()
		if (problem) return result('inconclusive', problem)
		if (review.decision !== 'accept')
			return result(review.decision === 'reject' ? 'rejected' : 'inconclusive', review.reason)
		await check()
		const evidence: LearningEvidence = {
			key: cycleId,
			source: `resident-learning-cycle:${cycleId}`,
			reason: `Paired verification and fresh confirmation of guidance derived from evidence ${failure.evidence.key}.`,
		}
		// Validate all existing activation contracts before entering the ambiguous
		// commit interval. The store repeats this against its atomic snapshot.
		promoteLearningSkill(
			snapshot.learning,
			candidate,
			{ verification, confirmation, protection },
			evidence,
		)
		await append('activation-requested', {
			baselineRevision,
			candidateRevision,
			agendaRevision: snapshot.revision,
		})
		options.signal.throwIfAborted()
		activationRequested = true
		const updated = await options.agenda.promoteSkill(
			snapshot,
			candidate,
			{ verification, confirmation, protection },
			evidence,
		)
		activatedRevision = updated.revision
		return result('activated', 'Evaluated guidance was committed for subsequent admissions.')
	}
	let outcome: LearningCycleResult
	try {
		outcome = await execute()
	} catch (error) {
		if (error instanceof LearningLeakError) leak = error.findings
		outcome = result(
			error instanceof ResidentConflictError
				? 'conflict'
				: activationRequested
					? 'activation-unknown'
					: options.signal.aborted
						? 'cancelled'
						: 'failed',
			error instanceof Error ? error.message : String(error),
		)
	}
	if (auditComplete) {
		try {
			await append('finished', { result: outcome })
		} catch {
			/* A committed activation is not undone by a journal failure. */
		}
	}
	return { ...outcome, auditComplete }
}
