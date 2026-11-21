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

/**
 * The same refusal for a session whose plan mode has a plan file and a way to
 * ask for approval: the plan goes in the file, and the exit tool puts it in
 * front of the person. Telling that model to "present the plan as your reply"
 * would send it around the approval dialog.
 */
export const PLAN_MODE_REFUSAL_WITH_PLAN_FILE =
	'Refused: plan mode is read-only. Explore with the reading tools (read, glob, grep, and shell commands that only read; run git on its own, not after cd), write the plan to the plan file, then call exit_plan_mode so the user can approve it. Change nothing else before then.'
