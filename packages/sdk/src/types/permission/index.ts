export type PermissionMode = 'plan' | 'auto'

/**
 * What the model is told when a mutating call is refused under plan mode.
 *
 * Here rather than beside the review policy because two doors say it: the
 * review-time policy (`createReviewPolicy({ mode: 'plan' })`) and the
 * execution-time floor in the tool registry. One text, so the model gets
 * the same instruction whichever door it hit.
 */
export const PLAN_MODE_REFUSAL =
	'Refused: plan mode is read-only. Explore with the reading tools, then present the plan as your reply — what you would change, in which files, and in what order. The user will switch out of plan mode to have it carried out.'
