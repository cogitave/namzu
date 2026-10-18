import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { workflowHarness } from './harness.js'

describe('wait_for_task on a workflow run id', () => {
	const open: Awaited<ReturnType<typeof workflowHarness>>[] = []
	afterEach(async () => {
		for (const h of open.splice(0)) {
			await h.close()
			removeTempDir(h.cwd)
		}
	})
	const make = async () => {
		const h = await workflowHarness()
		open.push(h)
		return h
	}

	it('answers in words, not as a bad task id', async () => {
		const h = await make()
		const result = await h.runtime.waitForTaskTool.execute({ task_id: 'wabc12345' }, h.context)
		expect(result.success).toBe(true)
		expect(result.output).toContain('workflow run')
		expect(result.output).toContain('one message when it ends')
		expect(result.output).not.toContain('UUID')
		const other = await h.runtime.waitForTaskTool.execute({ task_id: 'nonsense' }, h.context)
		expect(other.success).toBe(false)
	})
})
