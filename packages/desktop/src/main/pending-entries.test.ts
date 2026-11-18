import { expect, it } from 'vitest'
import { PendingQueue, QUICK_ENTRY_MAX_LENGTH } from './pending-entries.js'

it('keeps lines in order, hands each out once, and ignores blank ones', () => {
	const queue = new PendingQueue()
	expect(queue.addLine('   ')).toBe(false)
	expect(queue.addLine(' first ')).toBe(true)
	expect(queue.addLine('second')).toBe(true)
	queue.addVoice()
	expect(queue.take()).toEqual({ quickEntries: ['first', 'second'], voice: true })
	expect(queue.take()).toEqual({ quickEntries: [], voice: false })
})

it('cuts a very long line', () => {
	const queue = new PendingQueue()
	queue.addLine('x'.repeat(QUICK_ENTRY_MAX_LENGTH + 50))
	expect(queue.take().quickEntries[0]).toHaveLength(QUICK_ENTRY_MAX_LENGTH)
})
