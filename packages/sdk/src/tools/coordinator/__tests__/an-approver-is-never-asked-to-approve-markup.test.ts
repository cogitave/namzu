import { describe, expect, it } from 'vitest'

import type { TaskGateway } from '../../../types/agent/gateway.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * A model that serializes `steps` instead of building it tends to reach
 * for markup. Split on newlines, that string became one "step" per LINE —
 * so a host numbered `<step>`, `</step>` and `</steps>` in its approval
 * card and asked a person to approve them. Reported from a real run.
 *
 * The parse is checked here through the tool's own input schema, which is
 * where the preprocess actually runs.
 */
const SERIALIZED_AS_XML = `<steps>
<step>
<description>Write a test document covering the plan, the cases and the scenarios</description>
</step>
<step>
<description>Convert it to Word and save it under outputs/</description>
</step>
<step>
<description>Verify the file that was produced</description>
</step>
</steps>`

function unusedGateway(): TaskGateway {
	return {
		async createTask() {
			throw new Error('not used')
		},
		async waitForTask() {
			throw new Error('not used')
		},
		async continueTask() {},
		cancelTask() {},
		getTask() {
			return undefined
		},
		listTasks() {
			return []
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

function approvePlanTool() {
	const tools = buildCoordinatorTools({
		gateway: unusedGateway(),
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['sales-strategy'],
		getPlanManager: () => undefined,
	})
	const tool = tools.find((candidate) => candidate.name === 'approve_plan')
	if (!tool) throw new Error('approve_plan tool missing from coordinator builder')
	return tool
}

function parseSteps(steps: unknown): Array<{ description: string }> {
	const parsed = approvePlanTool().inputSchema.parse({
		title: 'Produce a test document',
		summary: 'Draft it, convert it, verify it.',
		steps,
	}) as { steps: Array<{ description: string }> }
	return parsed.steps
}

describe('an approver is never asked to approve markup', () => {
	it('reads the descriptions out of a step list serialized as XML', () => {
		expect(parseSteps(SERIALIZED_AS_XML).map((step) => step.description)).toEqual([
			'Write a test document covering the plan, the cases and the scenarios',
			'Convert it to Word and save it under outputs/',
			'Verify the file that was produced',
		])
	})

	it('drops the tag-only lines of a list it has to read line by line', () => {
		expect(parseSteps('<step>\nDraft the brief\n</step>').map((step) => step.description)).toEqual([
			'Draft the brief',
		])
	})

	it('yields no steps at all for a string that carries no words', () => {
		expect(parseSteps('<steps>\n</steps>')).toEqual([])
	})

	it('still reads a plain numbered list, and a JSON array', () => {
		expect(parseSteps('1. Draft the brief\n2. Send it').map((step) => step.description)).toEqual([
			'Draft the brief',
			'Send it',
		])
		expect(parseSteps('[{"description":"Draft the brief"}]')).toEqual([
			{ description: 'Draft the brief' },
		])
	})

	it('leaves a step that merely mentions a tag alone', () => {
		expect(parseSteps('Wrap the table in a <div> and re-render')).toEqual([
			{ description: 'Wrap the table in a <div> and re-render' },
		])
	})

	it('drops a line whose tags only look like content after one pass', () => {
		// Removing a tag can splice its neighbours into a new one:
		// `<<step>step>` loses the inner `<step>` and closes back up into
		// `<step>`. A single pass therefore reports "something is left" for a
		// line that is nothing but markup, and the approver is shown it.
		//
		// Raised by the static analyser as incomplete multi-character
		// sanitization, which is the same defect under a security name.
		expect(parseSteps('<<step>step>')).toEqual([])
		expect(parseSteps('<steps>\n<<step>step>\n</steps>')).toEqual([])
	})

	it('still keeps the content when the doubled tag has words around it', () => {
		// The fixed point must not eat the sentence — the failure mode of
		// over-correcting here is silently deleting a real step.
		expect(parseSteps('<<div>div>Render the summary')).toEqual([
			{ description: '<<div>div>Render the summary' },
		])
	})

	it('advertises the closed shape so a capable provider refuses the string outright', () => {
		// Surviving the serialization is not the same as preventing it: the
		// normalizer can only guess at a structure the model already threw
		// away. `ask_user_question` carries the same instrument for the same
		// failure.
		const tool = approvePlanTool()
		expect(tool.enforceModelInput).toBe(true)
		const schema = tool.modelInputSchema as {
			additionalProperties: boolean
			properties: { steps: { type: string; items: { additionalProperties: boolean } } }
		}
		expect(schema.additionalProperties).toBe(false)
		expect(schema.properties.steps.type).toBe('array')
		expect(schema.properties.steps.items.additionalProperties).toBe(false)
	})
})
