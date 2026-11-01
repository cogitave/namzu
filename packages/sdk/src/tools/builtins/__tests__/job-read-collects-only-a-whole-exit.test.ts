import { describe, expect, it, vi } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { JobTool } from '../job.js'

function contextWith(read: { status: string; droppedBytes: number }) {
	const markCollected = vi.fn()
	const context = {
		backgroundJobs: {
			get: () => ({ id: 'b00000001', status: read.status }),
			read: () => ({ chunk: 'tail', nextOffset: 10, ...read }),
			list: () => [],
			kill: vi.fn(),
			markCollected,
		},
	} as unknown as ToolContext
	return { context, markCollected }
}

describe('job read withdraws the exit notice only for an exit it delivered whole', () => {
	it('keeps the notice while the job is running', async () => {
		const f = contextWith({ status: 'running', droppedBytes: 0 })
		await JobTool.execute({ action: 'read', id: 'b00000001' }, f.context)
		expect(f.markCollected).not.toHaveBeenCalled()
	})

	it('keeps the notice when the retention cap dropped output the model never saw', async () => {
		const f = contextWith({ status: 'exited', droppedBytes: 5 })
		await JobTool.execute({ action: 'read', id: 'b00000001' }, f.context)
		expect(f.markCollected).not.toHaveBeenCalled()
	})

	it('withdraws it for a finished job read in full', async () => {
		const f = contextWith({ status: 'exited', droppedBytes: 0 })
		await JobTool.execute({ action: 'read', id: 'b00000001' }, f.context)
		expect(f.markCollected).toHaveBeenCalledExactlyOnceWith('b00000001')
	})
})
