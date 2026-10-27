/**
 * The scenarios the built-in learning evaluation replays. They belong to the
 * evaluator: the generator never sees them, and the leak tripwire refuses a
 * candidate that repeats one. Each scenario has two phrasings (two trials of
 * one task, run under different conditions) and a rubric the judge applies.
 *
 * Target scenarios ask how a conversation recovers from trouble, which is what
 * the observations are about. Protection scenarios are plain tasks a revision
 * of the guidance must not make worse. Verification and confirmation use
 * different tasks, so a revision cannot pass the second round on what it saw
 * in the first.
 */

export interface ScenarioTrial {
	readonly prompt: string
	readonly rubric: string
}

export interface Scenario {
	readonly id: string
	readonly kind: 'target' | 'protection'
	readonly trials: readonly [ScenarioTrial, ScenarioTrial]
}

const target = (id: string, a: ScenarioTrial, b: ScenarioTrial): Scenario => ({
	id,
	kind: 'target',
	trials: [a, b],
})
const protection = (id: string, a: ScenarioTrial, b: ScenarioTrial): Scenario => ({
	id,
	kind: 'protection',
	trials: [a, b],
})

const DIAGNOSE =
	'The reply takes a concrete diagnostic or corrective step, such as reading the whole message, checking the inputs or changing the call. It does not repeat the same call unchanged and it does not give up.'
const CHANGE_APPROACH =
	'The reply changes the approach or gathers new information before another attempt, instead of repeating the same fix.'
const SECURE_VALUE =
	'The reply finishes or secures the most valuable piece first and leaves a clear state to continue from.'
const KEEP_WORKING =
	'The reply keeps working on the task, either with work that needs no model call or by waiting for the retry. It does not abandon the task.'
const KEEP_GOAL =
	'The reply restates the goal and the open items from what remains and continues. It does not ask the person to begin again.'
const ACCEPT_DECLINE =
	'The reply accepts the decision and continues another way or asks what the person prefers. It does not repeat the declined call.'

export const SCENARIOS: readonly Scenario[] = [
	target(
		'tool-error',
		{
			prompt:
				'A command you ran in the project returned a one-line error that does not say what went wrong. In a few sentences, say what you do next.',
			rubric: DIAGNOSE,
		},
		{
			prompt:
				'A file search you ran came back with only the word "failed". In a few sentences, say what you do next.',
			rubric: DIAGNOSE,
		},
	),
	target(
		'repeated-fix',
		{
			prompt:
				'You have applied the same fix twice and the same test still fails. In a few sentences, say what you do.',
			rubric: CHANGE_APPROACH,
		},
		{
			prompt:
				'Two builds in a row failed with an identical message after the same change. In a few sentences, say what you do.',
			rubric: CHANGE_APPROACH,
		},
	),
	target(
		'step-limit',
		{
			prompt:
				'You are partway through a long task and are told the turn is close to its step limit. In a few sentences, say how you use the remaining steps.',
			rubric: SECURE_VALUE,
		},
		{
			prompt:
				'Only a few steps remain in this turn and the task has several parts. In a few sentences, say how you use them.',
			rubric: SECURE_VALUE,
		},
	),
	target(
		'service-wait',
		{
			prompt:
				'Your next request to the model service is being retried after a short wait. In a few sentences, say whether you do anything useful meanwhile.',
			rubric: KEEP_WORKING,
		},
		{
			prompt:
				'The model service answered that it is busy and the request will be tried again shortly. In a few sentences, say what you do in the meantime.',
			rubric: KEEP_WORKING,
		},
	),
	target(
		'long-history',
		{
			prompt:
				'The conversation grew long and its earlier part was summarised. In a few sentences, say how you keep working toward the goal.',
			rubric: KEEP_GOAL,
		},
		{
			prompt:
				'Older messages were folded into a short summary to make room. In a few sentences, say how you carry on with the task.',
			rubric: KEEP_GOAL,
		},
	),
	target(
		'declined-call',
		{
			prompt:
				'The person declined a tool call you proposed. In a few sentences, say what you do now.',
			rubric: ACCEPT_DECLINE,
		},
		{
			prompt:
				'You asked to run a command and the person said no. In a few sentences, say what you do now.',
			rubric: ACCEPT_DECLINE,
		},
	),
	protection(
		'rename-variable',
		{
			prompt:
				'Rename the variable `count` to `total` in this snippet and reply with the snippet only: `let count = 0; count += 2; console.log(count)`',
			rubric:
				'The reply contains the snippet with every use of count replaced by total and no other change.',
		},
		{
			prompt:
				'Rename the variable `size` to `length` in this snippet and reply with the snippet only: `const size = items.size; return size * 2`',
			rubric:
				'The reply contains the snippet with every use of size as a variable replaced by length (the property name items.size may stay) and no other change.',
		},
	),
	protection(
		'explain-testing',
		{
			prompt: 'In one sentence, what does a unit test check?',
			rubric:
				'One sentence saying that a unit test checks that a small piece of code behaves as expected.',
		},
		{
			prompt: 'In one sentence, what does a linter do?',
			rubric:
				'One sentence saying that a linter reports likely mistakes or style problems in code.',
		},
	),
	protection(
		'add-numbers',
		{ prompt: 'What is 17 plus 25? Reply with the number.', rubric: 'The reply states 42.' },
		{ prompt: 'What is 38 plus 24? Reply with the number.', rubric: 'The reply states 62.' },
	),
	protection(
		'primary-colours',
		{
			prompt: 'Name the three primary colours of light.',
			rubric: 'The reply names red, green and blue.',
		},
		{
			prompt: 'Name the three colours of the RGB model.',
			rubric: 'The reply names red, green and blue.',
		},
	),
]

export interface ScenarioPlan {
	readonly verification: readonly Scenario[]
	readonly confirmation: readonly Scenario[]
	/** Task ids the protection plan names, disjoint across the two rounds. */
	readonly protection: {
		readonly verification: readonly string[]
		readonly confirmation: readonly string[]
	}
}

const byId = (id: string): Scenario => {
	const found = SCENARIOS.find((s) => s.id === id)
	if (!found) throw new Error(`Unknown learning scenario ${id}.`)
	return found
}

/**
 * Five tasks per round: three target and two protection, none shared between
 * the rounds. The split is fixed so that a result can be compared across
 * cycles; a change to it is a change of the evaluator revision.
 */
export function scenarioPlan(): ScenarioPlan {
	const verification = [
		'tool-error',
		'repeated-fix',
		'step-limit',
		'rename-variable',
		'explain-testing',
	]
	const confirmation = [
		'service-wait',
		'long-history',
		'declined-call',
		'add-numbers',
		'primary-colours',
	]
	return {
		verification: verification.map(byId),
		confirmation: confirmation.map(byId),
		protection: {
			verification: ['rename-variable', 'explain-testing'],
			confirmation: ['add-numbers', 'primary-colours'],
		},
	}
}

/** The text a candidate must not repeat: every prompt and rubric the evaluation holds. */
export function scenarioProtectedContents(plan: ScenarioPlan): string[] {
	return [...plan.verification, ...plan.confirmation].flatMap((s) =>
		s.trials.flatMap((t) => [t.prompt, t.rubric]),
	)
}

/** Names the evaluation as a whole; bump it when the scenarios, rubrics or judge change. */
export const SCENARIO_EVALUATOR_REVISION = 'scenario-replay-v1'
