import { describe, expect, it } from 'vitest'
import { NAMED_KEYS, failedBeforeActing, keyCanCommit, namedKey, noEffectReason } from '../reach.js'

// Messages in the shape Playwright gives them: a timeout carries a call log, and the log
// reaches "performing click action" only once input is being sent.
const COVERED = Object.assign(
	new Error(`locator.click: Timeout 2000ms exceeded.
Call log:
  - waiting for locator('aria-ref=e2')
  -   locator resolved to <button id="b">Submit order</button>
  - attempting click action
  -   waiting for element to be visible, enabled and stable
  -   element is visible, enabled and stable
  -   scrolling into view if needed
  -   done scrolling
  -   <div id="veil"></div> intercepts pointer events
  - retrying click action`),
	{ name: 'TimeoutError' },
)
const NAVIGATING = Object.assign(
	new Error(`locator.click: Timeout 2000ms exceeded.
Call log:
  - attempting click action
  -   performing click action
  -   click action done
  -   waiting for scheduled navigations to finish`),
	{ name: 'TimeoutError' },
)

describe('named keys', () => {
	it('accepts exactly the short set, in any case', () => {
		expect(NAMED_KEYS).toEqual([
			'Escape',
			'Enter',
			'Tab',
			'Shift+Tab',
			'PageDown',
			'PageUp',
			'Home',
			'End',
			'Space',
		])
		expect(namedKey('escape')).toBe('Escape')
		expect(namedKey(' shift+tab ')).toBe('Shift+Tab')
		expect(namedKey('Control+A')).toBeUndefined()
		expect(namedKey('a')).toBeUndefined()
		expect(namedKey('Delete')).toBeUndefined()
	})

	it('flags the keys that can enter a character or submit', () => {
		expect(NAMED_KEYS.filter(keyCanCommit)).toEqual(['Enter', 'Space'])
	})
})

describe('telling a failed action by cause', () => {
	it('a timeout that never reached the input step changed nothing', () => {
		expect(failedBeforeActing(COVERED)).toBe(true)
		expect(noEffectReason(COVERED)).toBe('another element is covering it')
	})

	it('a timeout after the input was sent may have changed the page', () => {
		expect(failedBeforeActing(NAVIGATING)).toBe(false)
	})

	it('a timeout while typing may have left some of the text in the field', () => {
		const TYPING = Object.assign(
			new Error(`elementHandle.type: Timeout 2000ms exceeded.
Call log:
  - elementHandle.type("a long sentence")`),
			{ name: 'TimeoutError' },
		)
		expect(failedBeforeActing(TYPING)).toBe(false)
	})

	it('an error that is not a timeout is not claimed to be harmless', () => {
		expect(failedBeforeActing(new Error('Target closed'))).toBe(false)
		expect(failedBeforeActing('boom')).toBe(false)
	})

	it('names the reason in a clause', () => {
		const text = (message: string) => noEffectReason(new Error(message))
		expect(text('element is not visible')).toBe('it is not visible')
		expect(text('element is not enabled')).toBe('it is disabled')
		expect(text('element is not stable')).toBe('it kept moving')
		expect(text('Element is not attached to the DOM')).toBe('it left the page')
		expect(text('Timeout 2000ms exceeded.')).toBe('it did not become ready to act on in time')
	})
})
