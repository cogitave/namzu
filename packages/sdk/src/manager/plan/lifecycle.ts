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

	completePlan(): Plan | null {
		if (!this.currentPlan) return null

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

	failPlan(_error: string): Plan | null {
		if (!this.currentPlan) return null

		this.currentPlan.status = 'failed'
		this.currentPlan.completedAt = Date.now()

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
