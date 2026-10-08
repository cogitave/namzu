import { describe, expect, it } from 'vitest'
import { TerminalFeed } from './terminal-feed.js'

function feed() {
	const written: string[] = []
	let gaps = 0
	const f = new TerminalFeed(
		(data) => written.push(data),
		() => gaps++,
	)
	return { f, written, gaps: () => gaps }
}

describe('TerminalFeed', () => {
	it('holds output that arrives before the attach answers and draws what follows it', () => {
		const { f, written } = feed()
		f.accept(10, 'early')
		f.accept(15, 'later')
		expect(written).toEqual([])
		expect(f.next).toBeUndefined()
		f.resume(10)
		expect(written).toEqual(['early', 'later'])
		expect(f.next).toBe(20)
	})

	it('drops what the answer already covered and cuts an overlap', () => {
		const { f, written } = feed()
		f.accept(0, 'covered')
		f.accept(5, 'edXYZ')
		f.resume(7)
		expect(written).toEqual(['XYZ'])
		f.accept(8, 'YZ')
		f.accept(10, '!')
		expect(written).toEqual(['XYZ', '!'])
		expect(f.next).toBe(11)
	})

	it('reports a gap once and recovers when the view attaches again', () => {
		const { f, written, gaps } = feed()
		f.resume(0)
		f.accept(0, 'ab')
		f.accept(10, 'zz')
		f.accept(12, 'yy')
		expect(gaps()).toBe(1)
		expect(written).toEqual(['ab'])
		f.begin()
		f.accept(14, 'live')
		f.resume(14)
		expect(written).toEqual(['ab', 'live'])
		f.accept(99, 'x')
		expect(gaps()).toBe(2)
	})

	it('starts from the snapshot offset after a reset', () => {
		const { f, written } = feed()
		f.resume(100)
		f.begin()
		f.accept(30, 'old')
		f.reset(30)
		expect(f.next).toBe(33)
		expect(written).toEqual(['old'])
	})

	it('never moves the expected offset backwards on a later attach', () => {
		const { f } = feed()
		f.resume(50)
		f.begin()
		f.resume(20)
		expect(f.next).toBe(50)
	})
})
