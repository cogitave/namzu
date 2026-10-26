import { describe, expect, it } from 'vitest'

import { CODING_AGENT_WORKING_DOCTRINE as NAMZU_WORKING_DOCTRINE } from '../../../prompt/coding-agent-doctrine.js'
import { describeWithheldEnv, movedToBackgroundMessage } from '../bash.js'
import { EditTool } from '../edit.js'
import { WriteFileTool } from '../write-file.js'

/**
 * A tool result carries what happened. How to use the tool next lives in the
 * tool's own description, so a result never repeats a second copy of it.
 */
describe('shell results state facts', () => {
	it('says that credential-shaped variables were removed, without naming them', () => {
		const text = describeWithheldEnv(['OPENAI_API_KEY', 'DEPLOY_TOKEN'])
		expect(text).toBe(
			"NOTE: 2 credential-shaped environment variables were removed from this command's environment, so they read as unset. Ask the user if the command needs one.",
		)
		expect(text).not.toContain('OPENAI_API_KEY')
		expect(text).not.toMatch(/\bhost\b/)
	})

	it('uses the singular for one variable and says nothing for none', () => {
		expect(describeWithheldEnv(['A_TOKEN'])).toContain(
			'1 credential-shaped environment variable was',
		)
		expect(describeWithheldEnv([])).toBe('')
	})

	it('says a timed-out command moved to the background and gives no usage advice', () => {
		const text = movedToBackgroundMessage('job_1', 120_000)
		expect(text).toContain('moved to the background as job job_1')
		expect(text).toContain('You will be told when it ends')
		expect(text).not.toMatch(/wait_for_job|action "/)
	})
})

describe('size limits and branch rules give their reason', () => {
	it('explains the 12000 character payload cap on every edit and write parameter', () => {
		const text = JSON.stringify([EditTool.modelInputSchema, WriteFileTool.modelInputSchema])
		const caps = text.match(/under 12000 characters[^"]*/g) ?? []
		expect(caps.length).toBeGreaterThan(0)
		for (const cap of caps) expect(cap).toContain('because a longer one can be cut off mid-call')
	})

	it('explains why branches stay as the user left them', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain(
			"because the checked-out branch is the user's working state",
		)
		expect(NAMZU_WORKING_DOCTRINE).toContain(
			"because they spend the reader's attention on the past",
		)
	})
})
