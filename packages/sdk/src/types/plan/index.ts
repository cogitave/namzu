import type { PlanId, RunId } from '../ids/index.js'

export type PlanStatus =
	| 'generating'
	| 'ready'
	| 'pending_approval'
	| 'approved'
	| 'rejected'
	| 'executing'
	| 'completed'
	| 'failed'

export function isTerminalPlanStatus(status: PlanStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'rejected'
}

export interface PlanStep {
	id: string
	description: string
	toolName?: string

	/**
	 * Which agent this step is to be delegated to, when it is delegated at all.
	 *
	 * `approve_plan` invites the model to name an agent per step, and that
	 * answer was reduced to a boolean: the step got `toolName: 'create_task'`
	 * if any agent was named and nothing if not. So the human approving the
	 * plan was shown THAT a step delegates and never TO WHOM — while the model
	 * had said, and the approval is the one moment where the difference can
	 * still be acted on. Approving "delegate this" is not approving "delegate
	 * this to the agent with shell access".
	 *
	 * Typed rather than folded into {@link estimatedInput}, which is `unknown`:
	 * an approval gate's whole job is being readable, and a field a host has to
	 * cast before it can render is one a host renders wrong or not at all.
	 *
	 * Absent means the step is the orchestrator's own work, which is what
	 * omitting `agent_id` in `approve_plan` says.
	 */
	agentId?: string

	/**
	 * **No producer and no reader.** Nothing in the SDK writes this and
	 * nothing reads it; it is declared here and that is all. Noted rather
	 * than removed because it is on the published typings — see
	 * {@link agentId}, which is the field the plan approval path actually
	 * needed and did not have.
	 */
	estimatedInput?: unknown

	dependsOn: string[]
	status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
	error?: string
	order: number
}

export interface Plan {
	id: PlanId
	runId: RunId
	status: PlanStatus
	title: string
	summary?: string
	steps: PlanStep[]
	rawContent?: string
	createdAt: number
	readyAt?: number
	approvedAt?: number
	rejectedAt?: number
	completedAt?: number
	rejectionReason?: string

	/**
	 * Why the plan failed, when it did.
	 *
	 * `failPlan` has always taken this and thrown it away — the parameter was
	 * spelled `_error` because nothing read it. So a plan settled as `failed`
	 * carried no account of what went wrong, and the `plan_failed` event that
	 * reports it would have said "failed" and nothing else, which puts a reader
	 * exactly where the silence did.
	 *
	 * Distinct from {@link rejectionReason}: that is a human declining a plan
	 * before it ran, this is a plan that ran and did not finish.
	 */
	failureReason?: string
}

export interface PlanApprovalRequest {
	planId: PlanId
	runId: RunId
	title: string
	steps: PlanStep[]
	summary?: string
}

export interface PlanApprovalResponse {
	approved: boolean
	feedback?: string
	modifiedSteps?: PlanStep[]
}
