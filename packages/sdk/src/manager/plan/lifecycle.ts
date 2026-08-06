import type { RunId } from '../../types/ids/index.js'
import type {
	Plan,
	PlanApprovalRequest,
	PlanApprovalResponse,
	PlanStep,
} from '../../types/plan/index.js'
import { isTerminalPlanStatus } from '../../types/plan/index.js'
import { generatePlanId } from '../../utils/id.js'

export interface PlanEvent {
	type:
		| 'plan.generating'
		| 'plan.ready'
		| 'plan.approved'
		| 'plan.rejected'
		| 'plan.executing'
		| 'plan.step_updated'
		| 'plan.completed'
		| 'plan.failed'
	plan: Plan
	step?: PlanStep
}

export type PlanEventListener = (event: PlanEvent) => void

export type PlanApprovalHandler = (request: PlanApprovalRequest) => Promise<PlanApprovalResponse>

/**
 * The plan a run declares, and the gate a host approves it through.
 *
 * **The kernel deliberately drives only part of this class.** It builds a plan
 * (`approve_plan` calls `startGenerating` / `addStep` / `markReady`), gates it
 * (`iteration/phases/context.ts` calls `approve` and `startExecution`),
 * translates its events onto the run stream (`EventTranslator.wirePlanManager`),
 * and settles it on failure (`runtime/query/result.ts` calls `failPlan`). It
 * never reports a step outcome and never settles a plan that succeeded.
 *
 * That is a split, not an omission — `drainQuery` hands the manager to the host
 * through `onContextCreated({ planManager })` BEFORE the iteration loop starts,
 * precisely so a host can drive the half the kernel does not. So a grep for
 * callers of `updateStepStatus` or `completePlan` inside this package finds
 * none, and that is not evidence the methods are dead: the callers are hosts,
 * and they are outside the repository. `PlanManager` is exported from
 * `public-runtime.ts` for this reason.
 *
 * Recorded here because the absence has already been read once as a dead layer
 * and proposed for deletion. What it would have deleted is a working
 * human-in-the-loop approval gate.
 *
 * The one genuine gap in the split is tracked separately: nothing settles a
 * plan that SUCCEEDED, so its status can reach `failed` or stay `executing`
 * but never `completed`. Fixing that needs a decision about what a
 * kernel-built plan's steps mean, not a guessed status — see `completePlan`.
 */
export class PlanManager {
	private currentPlan: Plan | null = null
	private runId: RunId
	private listeners: PlanEventListener[] = []
	private approvalHandler?: PlanApprovalHandler

	constructor(runId: RunId, approvalHandler?: PlanApprovalHandler) {
		this.runId = runId
		this.approvalHandler = approvalHandler
	}

	setApprovalHandler(handler: PlanApprovalHandler): void {
		this.approvalHandler = handler
	}

	on(listener: PlanEventListener): () => void {
		this.listeners.push(listener)
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener)
		}
	}

	private emit(event: PlanEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {}
		}
	}

	get active(): Plan | null {
		return this.currentPlan
	}

	get isActive(): boolean {
		return this.currentPlan !== null && !isTerminalPlanStatus(this.currentPlan.status)
	}

	get needsApproval(): boolean {
		return this.currentPlan?.status === 'pending_approval'
	}

	/**
	 * Steps that have not said how they went — the reason `completePlan` may
	 * refuse, exposed so a caller can ask before it commits.
	 *
	 * The kernel settles a successful plan only when this is empty. It cannot
	 * catch the refusal instead: a throw on the success path would turn a run
	 * that worked into a run that crashed on its way out, which is a worse
	 * version of the bug the refusal exists to prevent.
	 */
	get unreportedSteps(): readonly PlanStep[] {
		if (!this.currentPlan) return []
		return this.currentPlan.steps.filter((s) => s.status === 'pending' || s.status === 'running')
	}

	startGenerating(title: string): Plan {
		const plan: Plan = {
			id: generatePlanId(),
			runId: this.runId,
			status: 'generating',
			title,
			steps: [],
			createdAt: Date.now(),
		}

		this.currentPlan = plan
		this.emit({ type: 'plan.generating', plan })
		return plan
	}

	addStep(step: Omit<PlanStep, 'status'>): PlanStep | null {
		if (!this.currentPlan) return null
		if (this.currentPlan.status !== 'generating') return null

		const planStep: PlanStep = {
			...step,
			status: 'pending',
		}

		this.currentPlan.steps.push(planStep)
		return planStep
	}

	markReady(summary?: string): Plan | null {
		if (!this.currentPlan) return null
		if (this.currentPlan.status !== 'generating') return null

		this.currentPlan.status = 'ready'
		this.currentPlan.summary = summary
		this.currentPlan.readyAt = Date.now()
		this.emit({ type: 'plan.ready', plan: this.currentPlan })
		return this.currentPlan
	}

	async requestApproval(): Promise<PlanApprovalResponse> {
		if (!this.currentPlan) {
			return { approved: false, feedback: 'No active plan' }
		}

		this.currentPlan.status = 'pending_approval'

		if (!this.approvalHandler) {
			this.currentPlan.status = 'rejected'
			this.currentPlan.rejectedAt = Date.now()
			this.currentPlan.rejectionReason = 'No approval handler configured'
			this.emit({ type: 'plan.rejected', plan: this.currentPlan })
			return { approved: false, feedback: 'No approval handler configured' }
		}

		const request: PlanApprovalRequest = {
			planId: this.currentPlan.id,
			runId: this.runId,
			title: this.currentPlan.title,
			steps: this.currentPlan.steps,
			summary: this.currentPlan.summary,
		}

		const response = await this.approvalHandler(request)

		if (response.approved) {
			if (response.modifiedSteps) {
				this.currentPlan.steps = response.modifiedSteps
			}
			this.currentPlan.status = 'approved'
			this.currentPlan.approvedAt = Date.now()
			this.emit({ type: 'plan.approved', plan: this.currentPlan })
		} else {
			this.currentPlan.status = 'rejected'
			this.currentPlan.rejectedAt = Date.now()
			this.currentPlan.rejectionReason = response.feedback
			this.emit({ type: 'plan.rejected', plan: this.currentPlan })
		}

		return response
	}

	approve(modifiedSteps?: PlanStep[]): Plan | null {
		if (!this.currentPlan) return null
		if (this.currentPlan.status !== 'pending_approval' && this.currentPlan.status !== 'ready')
			return null

		if (modifiedSteps) {
			this.currentPlan.steps = modifiedSteps
		}
		this.currentPlan.status = 'approved'
		this.currentPlan.approvedAt = Date.now()
		this.emit({ type: 'plan.approved', plan: this.currentPlan })
		return this.currentPlan
	}

	startExecution(): Plan | null {
		if (!this.currentPlan) return null
		if (this.currentPlan.status !== 'approved') return null

		this.currentPlan.status = 'executing'
		this.emit({ type: 'plan.executing', plan: this.currentPlan })
		return this.currentPlan
	}

	updateStepStatus(stepId: string, status: PlanStep['status'], error?: string): PlanStep | null {
		if (!this.currentPlan) return null

		const step = this.currentPlan.steps.find((s) => s.id === stepId)
		if (!step) return null

		step.status = status
		if (error) step.error = error

		this.emit({ type: 'plan.step_updated', plan: this.currentPlan, step })
		return step
	}

	/**
	 * Settle the plan, computing its outcome from its steps.
	 *
	 * A step that is still `pending` or `running` used to land here as
	 * **`failed`**, because the test was "is every step completed or skipped"
	 * and anything else fell to the same branch. So a caller that added steps,
	 * did the work, and settled the plan without reporting each step got
	 * `failed` for a plan that fully succeeded — and `addStep` defaults every
	 * step to `pending`, so that is the path of least effort, not an unusual
	 * one.
	 *
	 * The two cases are different facts and want different responses. A step
	 * that FAILED is an outcome: the plan failed, report it. A step nobody
	 * reported on is not an outcome at all — it says the caller and this plan
	 * disagree about whether the work is over, and answering "failed" resolves
	 * that disagreement by inventing a result.
	 *
	 * So an unfinished step is refused rather than scored. The message names
	 * the steps and the two ways out, because a caller in this position either
	 * forgot to report progress or called too early, and only they know which.
	 */
	completePlan(): Plan | null {
		if (!this.currentPlan) return null

		const unfinished = this.currentPlan.steps.filter(
			(s) => s.status === 'pending' || s.status === 'running',
		)
		if (unfinished.length > 0) {
			const named = unfinished.slice(0, 3).map((s) => s.description)
			const rest = unfinished.length - named.length
			const listed = rest > 0 ? `${named.join('; ')}, and ${rest} more` : named.join('; ')
			const counted = `${unfinished.length} of ${this.currentPlan.steps.length} steps`
			throw new Error(
				`Cannot complete plan "${this.currentPlan.title}": ${counted} have not reported an outcome (${listed}). Report each step with updateStepStatus — 'skipped' is a valid outcome — or call failPlan if the plan is being abandoned. Scoring an unreported step as a failure would report a plan that succeeded as one that did not.`,
			)
		}

		const allDone = this.currentPlan.steps.every(
			(s) => s.status === 'completed' || s.status === 'skipped',
		)

		this.currentPlan.status = allDone ? 'completed' : 'failed'
		this.currentPlan.completedAt = Date.now()
		this.emit({
			type: allDone ? 'plan.completed' : 'plan.failed',
			plan: this.currentPlan,
		})
		return this.currentPlan
	}

	failPlan(error: string): Plan | null {
		if (!this.currentPlan) return null

		this.currentPlan.status = 'failed'
		this.currentPlan.completedAt = Date.now()
		// Recorded rather than discarded. This argument was named `_error`
		// because nothing read it, so a failed plan carried no account of what
		// went wrong — and the event that now reports the failure would have
		// had nothing to say beyond the word.
		this.currentPlan.failureReason = error

		for (const step of this.currentPlan.steps) {
			if (step.status === 'pending' || step.status === 'running') {
				step.status = 'skipped'
			}
		}

		this.emit({ type: 'plan.failed', plan: this.currentPlan })
		return this.currentPlan
	}

	getNextPendingStep(): PlanStep | null {
		if (!this.currentPlan) return null
		if (this.currentPlan.status !== 'executing') return null

		for (const step of this.currentPlan.steps) {
			if (step.status !== 'pending') continue

			const depsResolved = step.dependsOn.every((depId) => {
				const dep = this.currentPlan?.steps.find((s) => s.id === depId)
				return dep && (dep.status === 'completed' || dep.status === 'skipped')
			})

			if (depsResolved) return step
		}

		return null
	}

	reset(): void {
		this.currentPlan = null
	}
}
