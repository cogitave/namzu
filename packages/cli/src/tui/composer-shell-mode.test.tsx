/**
 * Shell mode in the message box: `!` typed into an empty draft turns the box into a shell
 * line (the `!` is not kept, the mark becomes `!`, the placeholder goes), Backspace on the
 * empty line or Esc leaves it, and Enter still sends the line as `!` plus the text.
 */

import { Text } from 'ink'
import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Composer, type ComposerProps } from './Composer.js'
import { ComposerFrame, SHELL_HINT } from './ComposerFrame.js'
import { PALETTES, THEME_NAMES } from './theme-palettes.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function mount(extra: Partial<ComposerProps> = {}) {
	const sent: string[] = []
	const modes: boolean[] = []
	const app = render(
		React.createElement(Composer, {
			onSubmit: (value) => {
				sent.push(value)
			},
			onShellModeChange: (on) => modes.push(on),
			history: [],
			...extra,
		}),
	)
	return { app, sent, modes }
}

const press = async (app: ReturnType<typeof render>, input: string) => {
	app.stdin.write(input)
	await tick()
}

const BACKSPACE = '\x7f'
const ESC = '\x1b'

describe('shell mode in the composer', () => {
	afterEach(() => vi.useRealTimers())

	it('enters on a leading "!", drops it from the text and clears the placeholder', async () => {
		const { app, modes } = mount()
		await tick()
		expect(app.lastFrame()).toContain('❯')
		expect(app.lastFrame()).toContain('Type a message')
		await press(app, '!')
		const frame = app.lastFrame() ?? ''
		expect(modes).toEqual([true])
		expect(frame).not.toContain('Type a message')
		expect(frame).not.toContain('❯')
		expect(frame.trimStart().startsWith('!')).toBe(true)
		// The `!` is the mark, not part of the line.
		await press(app, 'l')
		await press(app, 's')
		expect(app.lastFrame()).toContain('ls')
		expect(app.lastFrame()).not.toContain('!ls')
	})

	it('sends the line as "!" plus the text and is a prompt again afterwards', async () => {
		const { app, sent, modes } = mount()
		await tick()
		for (const key of ['!', 'l', 's', ' ', '-', 'l']) await press(app, key)
		await press(app, '\r')
		expect(sent).toEqual(['!ls -l'])
		expect(modes).toEqual([true, false])
		expect(app.lastFrame()).toContain('❯')
	})

	it('sends nothing for an empty shell line', async () => {
		const { app, sent } = mount()
		await tick()
		await press(app, '!')
		await press(app, '\r')
		expect(sent).toEqual([])
	})

	it('leaves on Backspace only when the shell line is empty', async () => {
		const { app, modes } = mount()
		await tick()
		await press(app, '!')
		await press(app, 'a')
		await press(app, BACKSPACE)
		expect(modes).toEqual([true])
		await press(app, BACKSPACE)
		expect(modes).toEqual([true, false])
		expect(app.lastFrame()).toContain('❯')
		expect(app.lastFrame()).toContain('Type a message')
	})

	it('leaves on Esc and keeps what was typed', async () => {
		const { app, sent, modes } = mount()
		await tick()
		await press(app, '!')
		for (const key of ['l', 's']) await press(app, key)
		// A lone Esc byte waits for the input parser's timer to say it is not a sequence.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		app.stdin.write(ESC)
		await vi.advanceTimersByTimeAsync(100)
		vi.useRealTimers()
		await tick()
		expect(modes).toEqual([true, false])
		expect(app.lastFrame()).toContain('ls')
		await press(app, '\r')
		expect(sent).toEqual(['ls'])
	})

	it('keeps a later "!" as an ordinary character', async () => {
		const { app, sent, modes } = mount()
		await tick()
		await press(app, 'a')
		await press(app, '!')
		await press(app, '\r')
		expect(modes).toEqual([])
		expect(sent).toEqual(['a!'])
	})

	it('enters on a paste that begins with "!"', async () => {
		const { app, sent, modes } = mount()
		await tick()
		await press(app, '\x1b[200~!echo hi\x1b[201~')
		expect(modes).toEqual([true])
		expect(app.lastFrame()).toContain('echo hi')
		await press(app, '\r')
		expect(sent).toEqual(['!echo hi'])
	})

	it('does not read a slash as a command inside a shell line', async () => {
		const { app, sent } = mount()
		await tick()
		await press(app, '!')
		await press(app, '/')
		await press(app, 'b')
		expect(app.lastFrame()).not.toMatch(/\/(help|model|clear)/)
		await press(app, '\r')
		expect(sent).toEqual(['!/b'])
	})

	it('brings a shell line back from history in shell mode, and a prompt back as a prompt', async () => {
		const { app, modes } = mount({ history: ['fix the bug', '!git status'] })
		await tick()
		await press(app, '\x1b[A')
		expect(modes).toEqual([true])
		expect(app.lastFrame()).toContain('git status')
		expect(app.lastFrame()).not.toContain('!git')
		await press(app, '\x1b[A')
		expect(modes).toEqual([true, false])
		expect(app.lastFrame()).toContain('fix the bug')
		expect(app.lastFrame()).toContain('❯')
	})

	it('does not start shell mode in a plain text composer', async () => {
		const { app, sent, modes } = mount({ plainText: true })
		await tick()
		await press(app, '!')
		await press(app, 'x')
		await press(app, '\r')
		expect(modes).toEqual([])
		expect(sent).toEqual(['!x'])
	})
})

describe('the frame in shell mode', () => {
	const frame = (shell: boolean) =>
		render(
			<ComposerFrame columns={60} shell={shell}>
				<Text>body</Text>
			</ComposerFrame>,
		)

	it('says what the line is under the lower rule, only in shell mode', () => {
		expect(frame(true).lastFrame()).toContain(SHELL_HINT)
		expect(frame(false).lastFrame()).not.toContain('shell command')
	})

	it('keeps both rules whole', () => {
		const rows = (frame(true).lastFrame() ?? '').split('\n').filter((row) => row.includes('─'))
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(row.trim()).toBe('─'.repeat(60))
	})
})

describe('the shell-mode colour', () => {
	it('is defined in every palette', () => {
		for (const name of THEME_NAMES) expect(PALETTES[name].accent.shellMode).toBeTruthy()
	})

	it('is the theme green, or the blue accent where green is avoided', () => {
		for (const name of THEME_NAMES) {
			const { accent } = PALETTES[name]
			expect(accent.shellMode).toBe(accent.user)
		}
		expect(PALETTES.dark.accent.shellMode).toBe('ansi256(83)')
		expect(PALETTES['dark-ansi'].accent.shellMode).toBe('greenBright')
		expect(PALETTES['light-ansi'].accent.shellMode).toBe('green')
	})
})
