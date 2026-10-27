import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'
import { ExternalEditorError } from '../external-editor.js'
import type { Notice } from '../notifications.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))
const mounted: { unmount: () => void }[] = []

const CTRL_S = '\x13'
const CTRL_UNDERSCORE = '\x1f'
const ALT_P = '\x1bp'
const ALT_T = '\x1bt'
const ENTER = '\r'

afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
})

function open(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const onSubmit = vi.fn()
	const notices: Notice[] = []
	const harness = render(
		<Composer
			history={['an earlier message']}
			onSubmit={onSubmit}
			onFooterNotice={(notice) => notices.push(notice)}
			{...overrides}
		/>,
	)
	mounted.push(harness)
	return { ...harness, onSubmit, notices }
}

async function type(harness: ReturnType<typeof open>, text: string) {
	for (const ch of text) {
		harness.stdin.write(ch)
		await tick()
	}
}

describe('Ctrl+S stashes the draft', () => {
	it('sets the draft aside and brings it back on an empty composer', async () => {
		const harness = open()
		await type(harness, 'half written')
		harness.stdin.write(CTRL_S)
		await tick()
		expect(harness.lastFrame()).not.toContain('half written')
		expect(harness.notices.at(-1)?.text).toBe('Draft set aside · Ctrl+S to bring it back')

		harness.stdin.write(CTRL_S)
		await tick()
		expect(harness.lastFrame()).toContain('half written')
	})

	it('swaps with the draft already set aside instead of losing it', async () => {
		const harness = open()
		await type(harness, 'first draft')
		harness.stdin.write(CTRL_S)
		await tick()
		await type(harness, 'second draft')
		harness.stdin.write(CTRL_S)
		await tick()
		expect(harness.lastFrame()).toContain('first draft')
		expect(harness.lastFrame()).not.toContain('second draft')
		expect(harness.notices.at(-1)?.text).toBe(
			'Swapped with the draft set aside · Ctrl+S to swap back',
		)

		harness.stdin.write(CTRL_S)
		await tick()
		expect(harness.lastFrame()).toContain('second draft')
		expect(harness.lastFrame()).not.toContain('first draft')
	})

	it('does nothing on an empty composer with nothing set aside', async () => {
		const harness = open()
		harness.stdin.write(CTRL_S)
		await tick()
		expect(harness.lastFrame()).toContain('Type a message')
		expect(harness.notices).toHaveLength(0)
	})

	it('brings the draft back after the next message is sent', async () => {
		const harness = open()
		await type(harness, 'keep this')
		harness.stdin.write(CTRL_S)
		await tick()
		await type(harness, 'quick question')
		harness.stdin.write(ENTER)
		await tick()
		expect(harness.onSubmit).toHaveBeenCalledWith(
			'quick question',
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
		expect(harness.lastFrame()).toContain('keep this')
		expect(harness.notices.at(-1)?.text).toBe('Draft restored')
	})

	it('keeps the draft set aside while a slash command is sent', async () => {
		const harness = open()
		await type(harness, 'keep this')
		harness.stdin.write(CTRL_S)
		await tick()
		await type(harness, '/model ')
		harness.stdin.write(ENTER)
		await tick()
		expect(harness.lastFrame()).not.toContain('keep this')
	})

	it('still steps a history search to a newer match', async () => {
		const harness = open({ history: ['first one', 'second one'] })
		harness.stdin.write('\x12')
		await tick()
		harness.stdin.write('\x12')
		await tick()
		expect(harness.lastFrame()).toContain('first one')
		harness.stdin.write(CTRL_S)
		await tick()
		expect(harness.lastFrame()).toContain('second one')
		expect(harness.lastFrame()).not.toContain('Draft set aside')
	})
})

describe('Ctrl+_ undoes the draft', () => {
	it('takes typed text back a word at a time', async () => {
		const harness = open()
		await type(harness, 'one two')
		harness.stdin.write(CTRL_UNDERSCORE)
		await tick()
		expect(harness.lastFrame()).toContain('one ')
		expect(harness.lastFrame()).not.toContain('two')
		harness.stdin.write(CTRL_UNDERSCORE)
		await tick()
		harness.stdin.write(CTRL_UNDERSCORE)
		await tick()
		expect(harness.lastFrame()).toContain('Type a message')
	})

	it('undoes a deletion', async () => {
		const harness = open()
		await type(harness, 'abc')
		harness.stdin.write('\x15')
		await tick()
		expect(harness.lastFrame()).toContain('Type a message')
		harness.stdin.write(CTRL_UNDERSCORE)
		await tick()
		expect(harness.lastFrame()).toContain('abc')
	})

	it('does not put the underscore control character into the draft', async () => {
		const harness = open()
		harness.stdin.write(CTRL_UNDERSCORE)
		await tick()
		expect(harness.lastFrame()).toContain('Type a message')
	})

	it('has nothing to undo after a message is sent', async () => {
		const harness = open()
		await type(harness, 'sent')
		harness.stdin.write(ENTER)
		await tick()
		harness.stdin.write(CTRL_UNDERSCORE)
		await tick()
		expect(harness.lastFrame()).toContain('Type a message')
	})
})

describe('Alt+P and Alt+T', () => {
	it('asks for the model chooser and hands over what was typed', async () => {
		const harness = open()
		await type(harness, 'draft')
		harness.stdin.write(ALT_P)
		await tick()
		expect(harness.onSubmit).toHaveBeenLastCalledWith('/model', undefined, 'submit', {
			source: 'keybinding',
			draft: { text: 'draft' },
		})
	})

	it('asks for the chooser without a draft when nothing was typed', async () => {
		const harness = open()
		harness.stdin.write(ALT_P)
		await tick()
		expect(harness.onSubmit).toHaveBeenLastCalledWith('/model', undefined, 'submit', {
			source: 'keybinding',
		})
	})

	it('switches thinking through the host and never submits', async () => {
		const onToggleThinking = vi.fn()
		const harness = open({ onToggleThinking })
		await type(harness, 'draft')
		harness.stdin.write(ALT_T)
		await tick()
		expect(onToggleThinking).toHaveBeenCalledTimes(1)
		expect(harness.onSubmit).not.toHaveBeenCalled()
		expect(harness.lastFrame()).toContain('draft')
	})

	it('are not offered to a child conversation composer', async () => {
		const onToggleThinking = vi.fn()
		const harness = open({ plainText: true, onToggleThinking })
		harness.stdin.write(ALT_P)
		harness.stdin.write(ALT_T)
		await tick()
		expect(harness.onSubmit).not.toHaveBeenCalled()
		expect(onToggleThinking).not.toHaveBeenCalled()
	})
})

describe('Ctrl+X Ctrl+E', () => {
	it('opens the editor like Ctrl+G', async () => {
		const onExternalEdit = vi.fn(async (seed: string) => `${seed} edited`)
		const harness = open({ onExternalEdit })
		await type(harness, 'text')
		harness.stdin.write('\x18')
		await tick()
		harness.stdin.write('\x05')
		await tick()
		expect(onExternalEdit).toHaveBeenCalledWith('text', 'Ctrl+X Ctrl+E')
		expect(harness.lastFrame()).toContain('text edited')
	})

	it('names the key that was pressed when the editor cannot open', async () => {
		const notes: string[] = []
		const onExternalEdit = vi.fn(async () => {
			throw new ExternalEditorError('set VISUAL or EDITOR before pressing Ctrl+X Ctrl+E')
		})
		const harness = open({ onExternalEdit, onNotice: (text) => notes.push(text) })
		harness.stdin.write('\x18')
		await tick()
		harness.stdin.write('\x05')
		await tick()
		expect(notes.at(-1)).toBe(
			'Cannot open your editor: set VISUAL or EDITOR before pressing Ctrl+X Ctrl+E.',
		)
	})

	it('tells the host which single key opened the editor', async () => {
		const onExternalEdit = vi.fn(async (seed: string) => seed)
		const harness = open({ onExternalEdit })
		harness.stdin.write('\x07')
		await tick()
		expect(onExternalEdit).toHaveBeenCalledWith('', 'Ctrl+G')
	})
})
