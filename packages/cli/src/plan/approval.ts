import type { PermissionMode } from '../permissions/mode.js'

/**
 * The approval the person gives a plan.
 *
 * Rows and order, when no "clear the
 * context" row is configured: the first row leaves plan mode for auto-accepting
 * edits (or, when the session may run without asking, for that), the second for
 * asking before each edit, and the last is a text row, "keep planning", whose
 * typed words go back to the model. Approving keeps the conversation as it is.
 */
export interface PlanApprovalRequest {
	/** The plan as the file holds it now. */
	readonly plan: string
	/** Where the plan file is. */
	readonly planPath: string
	/** The session may run without asking (the launch flag or an earlier grant). */
	readonly bypassAvailable: boolean
}

export type PlanApprovalAnswer =
	/** Leave plan mode for `mode`; `feedback` is any words the person typed with it. */
	| {
			readonly kind: 'approve'
			readonly mode: PermissionMode
			readonly feedback?: string
	  }
	/** Stay in plan mode; `feedback` is what to change, absent when the person only backed out. */
	| { readonly kind: 'keep-planning'; readonly feedback?: string }

/** Asks the person; resolves when they answer. `signal` closes the dialog when nobody is waiting any more. */
export type PlanApprovalFn = (
	request: PlanApprovalRequest,
	signal?: AbortSignal,
) => Promise<PlanApprovalAnswer>

export interface PlanApprovalRow {
	readonly id: 'approve-auto' | 'approve-accept-edits' | 'approve-ask' | 'keep-planning'
	readonly label: string
	/** The mode an approving row leaves plan mode for. */
	readonly mode?: PermissionMode
}

export const KEEP_PLANNING_PLACEHOLDER = 'Tell namzu what to change'

/** The rows in the order they are shown and numbered. */
export function planApprovalRows(bypassAvailable: boolean): readonly PlanApprovalRow[] {
	return [
		bypassAvailable
			? {
					id: 'approve-auto',
					label: 'Yes, and run every tool without asking',
					mode: 'bypass',
				}
			: {
					id: 'approve-accept-edits',
					label: 'Yes, and auto-approve edits',
					mode: 'accept-edits',
				},
		{
			id: 'approve-ask',
			label: 'Yes, and ask before each edit',
			mode: 'prompt',
		},
		{ id: 'keep-planning', label: 'No, keep planning' },
	]
}

export const EXIT_PLAN_MODE_TOOL_NAME = 'exit_plan_mode'
