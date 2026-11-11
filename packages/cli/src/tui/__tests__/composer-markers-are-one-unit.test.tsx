import type { MessageAttachment } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'

const image: MessageAttachment = { data: 'aGVsbG8=', mediaType: 'image/png' }
const LEFT = '\x1b[D'
const DELETE = '\x1b[3~'
const BACKSPACE = '\x7f'
const CTRL_W = '\x17'
const CTRL_K = '\x0b'
const UNDO = '\x1f'
const WORD_LEFT = '\x1bb'

const mounted: { unmount: () => void }[] = []
afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
})

/** `look at [Image #1] now`, the cursor at its end, the image attached. */
async function open(
	text = 'look at [Image #1] now',
	attachments: readonly MessageAttachment[] = [image],
	extra: Partial<Parameters<typeof Composer>[0]> = {},
) {
	const onSubmit = vi.fn()
	const harness = render(
		<Composer
			history={[]}
			onSubmit={onSubmit}
			draftToRestore={{ token: 1, text, ...(attachments.length > 0 ? { attachments } : {}) }}
			{...extra}
		/>,
	)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame()).toContain(text.slice(0, 4)))
	const press = async (...keys: string[]) => {
		for (const key of keys) {
			harness.stdin.write(key)
			// Ink reads one key per event-loop turn; let it settle before the next.
			await new Promise((resolve) => setImmediate(resolve))
		}
	}
	const sent = async () => {
		await press('\r')
		await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled())
		return onSubmit.mock.calls[0] as [string, readonly MessageAttachment[] | undefined]
	}
	return { ...harness, press, sent }
}

describe('a marker is one unit in the composer', () => {
	it('is stepped over by Left in one key, and Delete takes all of it', async () => {
		const composer = await open()
		// " now" is four keys, then one more crosses the whole marker.
		await composer.press(LEFT, LEFT, LEFT, LEFT, LEFT, DELETE)
		const [text, attachments] = await composer.sent()
		expect(text).toBe('look at  now')
		expect(attachments).toBeUndefined()
	})

	it('never lets typing land inside it', async () => {
		const composer = await open()
		await composer.press(LEFT, LEFT, LEFT, LEFT, LEFT, 'X')
		const [text, attachments] = await composer.sent()
		expect(text).toBe('look at X[Image #1] now')
		expect(attachments).toEqual([image])
	})

	it('goes whole on Backspace, Ctrl+W and a word jump', async () => {
		const backspace = await open()
		await backspace.press(LEFT, LEFT, LEFT, LEFT, BACKSPACE)
		expect((await backspace.sent())[0]).toBe('look at  now')

		const word = await open('look at [Image #1]')
		await word.press(CTRL_W)
		const [text, attachments] = await word.sent()
		expect(text).not.toContain('[')
		expect(text).not.toContain('Image')
		expect(attachments).toBeUndefined()

		const jump = await open()
		await jump.press(WORD_LEFT, WORD_LEFT, 'X')
		// Two jumps back: over "now", then over the marker as one word, not into it.
		const [jumped, kept] = await jump.sent()
		expect(jumped).toBe('look at X[Image #1] now')
		expect(kept).toEqual([image])
	})

	it('goes whole on a kill to the end of the line from before it', async () => {
		const composer = await open()
		await composer.press(LEFT, LEFT, LEFT, LEFT, LEFT, CTRL_K)
		const [text, attachments] = await composer.sent()
		expect(text).toBe('look at')
		expect(attachments).toBeUndefined()
	})

	it('comes back with its image when the delete is undone', async () => {
		const composer = await open()
		await composer.press(LEFT, LEFT, LEFT, LEFT, BACKSPACE)
		await vi.waitFor(() => expect(composer.lastFrame()).not.toContain('Image #1'))
		await composer.press(UNDO)
		await vi.waitFor(() => expect(composer.lastFrame()).toContain('[Image #1]'))
		const [text, attachments] = await composer.sent()
		expect(text).toBe('look at [Image #1] now')
		expect(attachments).toEqual([image])
	})

	it('treats text that only looks like a marker as ordinary text', async () => {
		const composer = await open('see [Image #5] there', [])
		// " there" is six keys; the seventh enters the look-alike one character at a time.
		await composer.press(LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, LEFT, 'X')
		expect((await composer.sent())[0]).toBe('see [Image #5X] there')
	})
})

describe('numbers run through the conversation', () => {
	it('numbers a restored attachment after the highest the conversation used', async () => {
		const composer = await open('look', [image], { attachmentFloor: 4 })
		await vi.waitFor(() => expect(composer.lastFrame()).toContain('[Image #5]'))
		const [text] = await composer.sent()
		expect(text).toBe('[Image #5] look')
	})

	it('keeps the numbers the text already names', async () => {
		const second: MessageAttachment = { data: 'd29ybGQ=', mediaType: 'image/png' }
		const composer = await open('compare [Image #3] with [Image #4]', [image, second], {
			attachmentFloor: 4,
		})
		const [text, attachments] = await composer.sent()
		expect(text).toBe('compare [Image #3] with [Image #4]')
		expect(attachments).toEqual([image, second])
	})
})
