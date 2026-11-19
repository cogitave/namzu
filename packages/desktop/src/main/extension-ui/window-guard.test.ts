import { describe, expect, it } from 'vitest'
import { isNewDocument, watchWindow } from './window-guard.js'

type H = (...a: unknown[]) => void

const fake = () => {
	const win: Record<string, H[]> = {}
	const wc: Record<string, H[]> = {}
	const add = (into: Record<string, H[]>) => (e: string, h: H) => {
		const list = into[e] ?? []
		list.push(h)
		into[e] = list
	}
	return { win, wc, w: { on: add(win), webContents: { on: add(wc) } } }
}

describe('the window guard', () => {
	it('closes the views when the window closes, its screen crashes or loads another document', () => {
		const f = fake()
		let n = 0
		watchWindow(f.w as never, () => {
			n++
		})
		f.win.closed?.[0]?.()
		f.wc['render-process-gone']?.[0]?.({}, { reason: 'crashed' })
		f.wc.destroyed?.[0]?.()
		f.wc['did-start-navigation']?.[0]?.({
			isMainFrame: true,
			isSameDocument: false,
		})
		expect(n).toBe(4)
	})
	it('does not close them for a frame inside the page or a change that stays in the same document', () => {
		expect(isNewDocument([{ isMainFrame: false, isSameDocument: false }])).toBe(false)
		expect(isNewDocument([{ isMainFrame: true, isSameDocument: true }])).toBe(false)
		expect(isNewDocument([{ isMainFrame: true, isSameDocument: false }])).toBe(true)
		// the older positional form: (event, url, isInPlace, isMainFrame)
		expect(isNewDocument([{}, 'x', false, true])).toBe(true)
		expect(isNewDocument([{}, 'x', true, true])).toBe(false)
		expect(isNewDocument([{}, 'x', false, false])).toBe(false)
	})
})
