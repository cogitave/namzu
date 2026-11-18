import { describe, expect, it } from 'vitest'

import type { ContextReport } from '../shared/context-protocol.js'
import { type ContextRead, ContextReader } from './context-panel-reader.js'

function report(over: Partial<ContextReport> = {}): ContextReport {
	return {
		detail: 'summary',
		windowTokens: 1000,
		totalTokens: 100,
		percentage: 10,
		autoCompact: { enabled: true, bufferTokens: 10 },
		categories: [],
		approximate: false,
		...over,
	}
}

function setup() {
	const asked: string[] = []
	const answers: ((value: ContextReport | null) => void)[] = []
	const failures: ((reason: unknown) => void)[] = []
	const reads: ContextRead[] = []
	const timers: { run: () => void; ms: number; cancelled: boolean }[] = []
	const reader = new ContextReader({
		ask: (detail) => {
			asked.push(detail)
			return new Promise((resolve, reject) => {
				answers.push(resolve)
				failures.push(reject)
			})
		},
		publish: (read) => reads.push(read),
		schedule: (run, ms) => {
			const timer = { run, ms, cancelled: false }
			timers.push(timer)
			return () => {
				timer.cancelled = true
			}
		},
	})
	return { reader, asked, answers, failures, reads, timers }
}

const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('the context reader', () => {
	it('asks for the full answer when the panel opens', async () => {
		const { reader, asked, answers, reads } = setup()
		reader.open()
		expect(asked).toEqual(['full'])
		answers[0]?.(report({ detail: 'full' }))
		await flush()
		expect(reads.at(-1)?.report?.totalTokens).toBe(100)
		expect(reads.at(-1)?.loading).toBe(false)
	})

	it('asks again after a usage notice, once per 400 ms however many arrive', async () => {
		const { reader, asked, answers, timers } = setup()
		reader.open()
		answers[0]?.(report())
		await flush()
		reader.usageChanged()
		reader.usageChanged()
		reader.usageChanged()
		expect(timers).toHaveLength(1)
		expect(timers[0]?.ms).toBe(400)
		timers[0]?.run()
		expect(asked).toEqual(['full', 'summary'])
	})

	it('ignores usage notices while closed and drops a waiting refresh when it closes', async () => {
		const { reader, asked, answers, timers } = setup()
		reader.usageChanged()
		expect(timers).toHaveLength(0)
		reader.open()
		answers[0]?.(report())
		await flush()
		reader.usageChanged()
		reader.close()
		expect(timers[0]?.cancelled).toBe(true)
		expect(asked).toEqual(['full'])
	})

	it('keeps the lists from the full answer when a short one refreshes the figures', async () => {
		const { reader, answers, reads, timers } = setup()
		reader.open()
		const lists = {
			mcpTools: [],
			deferredTools: [],
			skills: [{ name: 'a', source: 'user', tokens: 5 }],
			agents: [],
			memoryFiles: [],
		}
		answers[0]?.(report({ detail: 'full', lists }))
		await flush()
		reader.usageChanged()
		timers[0]?.run()
		answers[1]?.(report({ totalTokens: 300 }))
		await flush()
		expect(reads.at(-1)?.report?.totalTokens).toBe(300)
		expect(reads.at(-1)?.report?.lists?.skills).toHaveLength(1)
	})

	it('only the newest answer counts', async () => {
		const { reader, answers, reads, timers } = setup()
		reader.open()
		reader.usageChanged()
		timers[0]?.run()
		answers[1]?.(report({ totalTokens: 300 }))
		await flush()
		answers[0]?.(report({ totalTokens: 1 }))
		await flush()
		expect(reads.at(-1)?.report?.totalTokens).toBe(300)
	})

	it('says so when the engine has not counted yet, and keeps the screen when a refresh fails', async () => {
		const first = setup()
		first.reader.open()
		first.answers[0]?.(null)
		await flush()
		expect(first.reads.at(-1)?.empty).toBe(true)

		const second = setup()
		second.reader.open()
		second.answers[0]?.(report())
		await flush()
		second.reader.usageChanged()
		second.timers[0]?.run()
		second.failures[1]?.(new Error('x'))
		await flush()
		expect(second.reads.at(-1)?.report?.totalTokens).toBe(100)
		expect(second.reads.at(-1)?.error).toBeUndefined()

		const third = setup()
		third.reader.open()
		third.failures[0]?.(new Error('x'))
		await flush()
		expect(third.reads.at(-1)?.error).toBe(true)
	})

	it('publishes nothing after it closes', async () => {
		const { reader, answers, reads } = setup()
		reader.open()
		const before = reads.length
		reader.close()
		answers[0]?.(report())
		await flush()
		expect(reads).toHaveLength(before)
	})
})
