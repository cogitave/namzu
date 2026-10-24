/**
 * The sentence that opens every workflow agent's prompt, kept apart from the
 * runtime so the activity record can leave it out of what the person reads.
 */

/** Opens every workflow agent's prompt: the step is the job, so a note about authority cannot read as a reason to skip it. */
export const WORKFLOW_STEP_ASSIGNMENT =
	'This step is your assigned job. The person who started this workflow approved the script that gives it to you, so carry it out and report what you found or did; do not decline it or skip it.'

/**
 * The prompt as the person should see it: the step task only. The assignment
 * sentence is for the model; shown as the person's prompt it reads as raw
 * instructions they never wrote.
 */
export function stepTaskOnly(prompt: string): string {
	const opening = `${WORKFLOW_STEP_ASSIGNMENT}\n\n`
	return prompt.startsWith(opening) ? prompt.slice(opening.length) : prompt
}
