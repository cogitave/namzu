/**
 * Resuming a workflow is reviewed like starting one: the operator sees which
 * run it continues, what it can reuse, and the script that will run.
 */

import { describe, expect, it } from 'vitest'

import { permissionAnswers, permissionQuestion, permissionTitle } from '../PermissionOverlay.js'
import { buildPermissionReview, buildPermissionSummary } from '../permission-review.js'

const SCRIPT =
	"export const meta = { name: 'audit', description: 'Scan, then fix' }\nreturn await agent('scan')"

function summaryOf(
	input: Record<string, unknown>,
	context: Parameters<typeof buildPermissionSummary>[1] = {},
) {
	const calls = [{ id: 'w1', name: 'workflow', input, isDestructive: false }]
	const review = buildPermissionReview(calls)
	if (!review.ok) throw new Error('fixture must fit the approval envelope')
	return { calls, summary: buildPermissionSummary(review.text, context) }
}

const review = (over: Record<string, unknown> = {}) => ({
	runId: 'wabcdefgh',
	pass: 3,
	previousFinish: 'unfinished' as const,
	resumable: true,
	legacy: false,
	saved: 6,
	unfinished: 2,
	failed: 1,
	problems: [],
	...over,
})

describe('the review of a workflow resume', () => {
	it('says which run it continues and what it can reuse, for an edited script', () => {
		const { summary } = summaryOf(
			{ script: SCRIPT, resumeFromRunId: 'wabcdefgh' },
			{ describeWorkflowResume: () => review({ scriptChanged: true }) },
		)
		expect(summary.text).toContain(
			'Resumes run wabcdefgh (pass 3; the previous pass did not finish)',
		)
		expect(summary.text).toContain(
			'Up to 6 agents can return saved results; the rest run live. Unfinished: 2. Failed or skipped: 1.',
		)
		expect(summary.text).toContain('edited since the run started')
		expect(summary.text).toContain('Workflow: audit')
	})

	it('gives exact figures when the script is unchanged and names a damaged journal', () => {
		const { summary } = summaryOf(
			{ script: SCRIPT, resumeFromRunId: 'wabcdefgh' },
			{ describeWorkflowResume: () => review({ scriptChanged: false, brokenAt: 41 }) },
		)
		expect(summary.text).toContain(
			'About 6 agents return saved results and are not run again; the rest run live.',
		)
		expect(summary.text).toContain('Script: unchanged since the run started')
		expect(summary.text).toContain('Journal: changed or cut short at line 41')
	})

	it('reads the script from the saved file when only the path is given', () => {
		const { summary } = summaryOf(
			{ scriptPath: '/s/audit-wabcdefgh.js', resumeFromRunId: 'wabcdefgh' },
			{
				readWorkflowScript: (path) => (path === '/s/audit-wabcdefgh.js' ? SCRIPT : undefined),
				describeWorkflowResume: (_id, script) => review({ scriptChanged: script !== SCRIPT }),
			},
		)
		expect(summary.text).toContain('Workflow: audit')
		expect(summary.text).toContain('Script: unchanged')
		expect(summary.expandedText).toContain("agent('scan')")
	})

	it('falls back to the plain envelope when the saved script cannot be read', () => {
		const { summary } = summaryOf({ scriptPath: '/gone.js', resumeFromRunId: 'wabcdefgh' })
		expect(summary.text).not.toContain('Workflow: audit')
	})

	it('words the title, the question and the answer as a resume', () => {
		const { calls } = summaryOf({ script: SCRIPT, resumeFromRunId: 'wabcdefgh' })
		expect(permissionTitle(calls)).toBe('Resume a workflow')
		expect(permissionQuestion(calls)).toBe('Do you want to resume this workflow?')
		expect(permissionAnswers(calls)[0]?.label).toBe('Resume this workflow')
		const start = summaryOf({ script: SCRIPT }).calls
		expect(permissionTitle(start)).toBe('Start a workflow')
	})
})
