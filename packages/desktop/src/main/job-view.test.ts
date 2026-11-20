import { expect, it } from 'vitest'
import { jobRows, jobTail } from './job-view.js'

it('names the end time of an ended job completedAt and leaves other rows alone', () => {
	const rows = jobRows([
		{ id: 'a', status: 'exited', exitedAt: 50 },
		{ id: 'b', status: 'running' },
		{ id: 'c', status: 'killed', exitedAt: 9, completedAt: 7 },
	])
	expect(rows).toEqual([
		{ id: 'a', status: 'exited', exitedAt: 50, completedAt: 50 },
		{ id: 'b', status: 'running' },
		{ id: 'c', status: 'killed', exitedAt: 9, completedAt: 7 },
	])
	expect(jobRows('nope')).toEqual([])
})

it('keeps a short output whole', () => {
	expect(jobTail('hello\n', 0)).toEqual({ output: 'hello\n', truncated: false, size: 6 })
	expect(jobTail('x', 12).truncated).toBe(true)
})

it('keeps only the last bytes of a long output, never half a character', () => {
	const tail = jobTail('é'.repeat(10), 0, 7)
	// Ten two-byte characters, seven bytes kept: three whole characters.
	expect(tail).toEqual({ output: 'ééé', truncated: true, size: 20 })
})
