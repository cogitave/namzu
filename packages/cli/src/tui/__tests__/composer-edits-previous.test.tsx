import type { MessageAttachment } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const mounted: { unmount: () => void }[] = []

afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
})

function open(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const onSubmit = vi.fn()
	const onEditPrevious = vi.fn()
	const onDraftRestored = vi.fn()
	const harness = render(
		<Composer
			history={[]}
			onSubmit={onSubmit}
			onEditPrevious={onEditPrevious}
			onDraftRestored={onDraftRestored}
			{...overrides}
		/>,
	)
	mounted.push(harness)
	return { ...harness, onSubmit, onEditPrevious, onDraftRestored }
}

describe('Esc ×2 previous-prompt entry', () => {
	it('primes on the first empty Esc and opens only on the second', async () => {
		const harness = open()

		harness.stdin.write('\x1B')
		await tick()
		expect(harness.onEditPrevious).not.toHaveBeenCalled()
		expect(harness.lastFrame()).toContain('Press Esc again')

		harness.stdin.write('\x1B')
		await tick()
		expect(harness.onEditPrevious).toHaveBeenCalledTimes(1)
	})

	it('clears a non-empty draft before it can arm editing', async () => {
		const harness = open()
		harness.stdin.write('do not branch this')
		await tick()

		harness.stdin.write('\x1B')
		await tick()
		expect(harness.lastFrame()).not.toContain('do not branch this')
		expect(harness.lastFrame()).not.toContain('Press Esc again')

		harness.stdin.write('\x1B')
		await tick()
		expect(harness.onEditPrevious).not.toHaveBeenCalled()
		expect(harness.lastFrame()).toContain('Press Esc again')
	})

	it('does not arm while Esc belongs to a running turn', async () => {
		const harness = open({ escapeInterrupts: true })
		harness.stdin.write('\x1B')
		await tick()
		harness.stdin.write('\x1B')
		await tick()

		expect(harness.onEditPrevious).not.toHaveBeenCalled()
		expect(harness.lastFrame()).not.toContain('Press Esc again')
	})
})

describe('restoring a selected prompt', () => {
	it('submits the edited text with every durable attachment variant intact', async () => {
		const attachments: readonly MessageAttachment[] = [
			{ data: 'aGVsbG8=', mediaType: 'image/png' },
			{
				type: 'document',
				data: 'UERG',
				mediaType: 'application/pdf',
				name: 'design.pdf',
				citations: true,
			},
			{
				type: 'stored',
				ref: 'sha256:abc',
				mediaType: 'image/webp',
				kind: 'image',
				name: 'diagram.webp',
			},
		]
		const harness = open({
			draftToRestore: { token: 7, text: 'original prompt', attachments },
		})
		await tick()

		expect(harness.lastFrame()).toContain('original prompt')
		expect(harness.lastFrame()).toContain('Image #1')
		expect(harness.lastFrame()).toContain('Document #2 — design.pdf')
		expect(harness.lastFrame()).toContain('Image #3 — diagram.webp (stored)')
		expect(harness.onDraftRestored).toHaveBeenCalledWith(7)

		harness.stdin.write(' revised')
		await tick()
		harness.stdin.write('\r')
		await tick()

		expect(harness.onSubmit).toHaveBeenCalledWith('original prompt revised', attachments)
	})
})

describe('bounded recalled source display', () => {
	it('bounds and escapes the Ink view while resubmitting the exact edited source', async () => {
		const hiddenHead = 'HEAD-MUST-STAY-IN-SOURCE-BUT-NOT-IN-THE-FRAME'
		const unsafeTail = `tail-before\u0007direction\u202eTAIL-MUST-BE-VISIBLE`
		const source = `${hiddenHead}${'x'.repeat(100_000)}\n${unsafeTail}`
		const harness = open({ history: [source] })

		// Recall the complete prior prompt. The display is a bounded tail; the
		// source retained behind it is what Enter must submit.
		harness.stdin.write('\u001b[A')
		await tick()

		const frame = harness.lastFrame() ?? ''
		expect(frame.length).toBeLessThan(5_000)
		expect(frame).toContain('… ')
		expect(frame).not.toContain(hiddenHead)
		expect(frame).toContain('TAIL-MUST-BE-VISIBLE')
		expect(frame).toContain('\\u{0007}')
		expect(frame).toContain('\\u{202e}')
		expect(frame).not.toContain('\u0007')
		expect(frame).not.toContain('\u202e')

		harness.stdin.write('!')
		await tick()
		harness.stdin.write('\r')
		await tick()

		expect(harness.onSubmit).toHaveBeenCalledWith(`${source}!`, undefined)
	})

	it('bounds short multiline history by logical lines independently of bytes', async () => {
		const source = Array.from(
			{ length: 24 },
			(_value, index) => `history-line-${index.toString().padStart(2, '0')}`,
		).join('\n')
		const harness = open({ history: [source] })

		harness.stdin.write('\u001b[A')
		await tick()

		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('… history-line-16')
		expect(frame).toContain('history-line-23')
		expect(frame).not.toContain('history-line-15')
		expect(frame).not.toContain('history-line-00')
	})
})
