// A seam for putting something in the system prompt. The prompt was closed:
// every section was a branch inside `PromptBuilder`, so a capability that
// needed the model to know something had to argue for a branch or splice
// into `systemPrompt` and lose whatever was there.
export {
	PromptContributionCollisionError,
	PromptContributionRegistry,
	SKILLS_CONTRIBUTION_ID,
	skillsContribution,
} from './contributions.js'
export type {
	PromptContribution,
	PromptContributionContext,
	PromptPlacement,
} from './contributions.js'
