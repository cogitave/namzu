/** Production-renderer observers for terminal composer keys and geometry. */

import type { MessageAttachment } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import type { ComposerSubmitMode } from '../Composer.js'
import { Composer, suggestionWindowSize } from '../Composer.js'
import { matchSlashCommands } from '../slashCommands.js'
import { renderToScreen } from './support/screen.js'

const clipboardImage = {
	data: 'iVBORw0KGgo=',
	mediaType: 'image/png' as const,
}

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => ({ kind: 'image' as const, image: clipboardImage }),
}))

function composer(
	onSubmit: (
		value: string,
		attachments?: readonly MessageAttachment[],
		mode?: ComposerSubmitMode,
	) => void,
) {
	return <Composer history={[]} onSubmit={onSubmit} />
}

async function waitUntil(screen: Awaited<ReturnType<typeof renderToScreen>>, check: () => boolean) {
	const started = performance.now()
	while (!check() && performance.now() - started < 3_000) {
		await new Promise((resolve) => setTimeout(resolve, 20))
		await screen.waitForRender()
	}
	expect(check()).toBe(true)
}

describe('the composer on a production-shaped terminal', () => {
	it('uses spare terminal height for more slash commands without growing unbounded', async () => {
		expect(suggestionWindowSize(undefined)).toBe(6)
		expect(suggestionWindowSize(24)).toBe(6)
		expect(suggestionWindowSize(40)).toBe(12)
		expect(suggestionWindowSize(200)).toBe(12)

		const matches = matchSlashCommands('/', [])
		expect(matches.length).toBeGreaterThan(12)
		const screen = await renderToScreen(composer(vi.fn()), {
			cols: 120,
			rows: 40,
		})
		try {
			screen.press('/')
			await screen.waitForRender()
			const viewport = screen.viewport().join('\n')
			for (const command of matches.slice(0, 12)) {
				expect(viewport).toContain(`/${command.name}`)
			}
			expect(viewport).not.toContain(`/${matches[12]?.name}`)
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the conservative six-row slash window on a short terminal', async () => {
		const matches = matchSlashCommands('/', [])
		const screen = await renderToScreen(composer(vi.fn()), {
			cols: 120,
			rows: 24,
		})
		try {
			screen.press('/')
			await screen.waitForRender()
			const viewport = screen.viewport().join('\n')
			for (const command of matches.slice(0, 6)) {
				expect(viewport).toContain(`/${command.name}`)
			}
			expect(viewport).not.toContain(`/${matches[6]?.name}`)
		} finally {
			await screen.unmount()
		}
	})

	it('uses the same tall-terminal window for project file completion', async () => {
		const files = Array.from({ length: 16 }, (_, index) =>
			`src/file-${String(index).padStart(2, '0')}.ts`,
		)
		const screen = await renderToScreen(
			<Composer history={[]} mentionCandidates={files} onSubmit={vi.fn()} />,
			{ cols: 120, rows: 40 },
		)
		try {
			screen.press('@src/file-')
			await screen.waitForRender()
			const viewport = screen.viewport().join('\n')
			for (const file of files.slice(0, 12)) expect(viewport).toContain(`@${file}`)
			expect(viewport).not.toContain(`@${files[12]}`)
		} finally {
			await screen.unmount()
		}
	})

	it('accepts the Alt+V byte sequence as the same image action as Ctrl+V', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('\x1bv')
			await screen.waitForRender()

			expect(screen.scrollback()).toContainEqual(expect.stringContaining('Image #1'))

			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledWith('', [clipboardImage])
		} finally {
			await screen.unmount()
		}
	})

	it('routes modified effort keys without moving through history or editing the draft', async () => {
		const submit = vi.fn()
		const directions: string[] = []
		const screen = await renderToScreen(
			<Composer
				history={['older prompt']}
				onSubmit={submit}
				onStepReasoningEffort={(direction) => directions.push(direction)}
			/>,
			{ cols: 100, rows: 16 },
		)
		try {
			screen.press('keep draft')
			screen.press('\x1b[1;2A')
			screen.press('\x1b[1;2B')
			// Ink can distinguish Alt+punctuation once the enhanced keyboard
			// protocol requested by launchTui is active. The modifier parameter
			// is one plus the Alt bit, hence `3`.
			screen.press('\x1b[46;3u')
			screen.press('\x1b[44;3u')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(directions).toEqual(['raise', 'lower', 'raise', 'lower'])
			expect(submit).toHaveBeenCalledWith('keep draft', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('uses whitespace-delimited Ctrl+W word rubout', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('keep hello-world   ')
			await screen.waitForRender()
			screen.press('\x17')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('keep', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('inserts at the visible left/right cursor instead of appending at the end', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('helo')
			await screen.waitForRender()
			screen.press('\x1b[D')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('hel▏o')

			screen.press('l')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledWith('hello', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('moves across and deletes a complete grapheme instead of splitting its bytes', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('a👨‍👩‍👧‍👦b')
			await screen.waitForRender()
			screen.press('\x1b[D')
			await screen.waitForRender()
			screen.press('\x7f')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('ab', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('supports Home/End and their Ctrl+A/Ctrl+E terminal bindings', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('tail')
			await screen.waitForRender()
			screen.press('\x01')
			await screen.waitForRender()
			screen.press('head ')
			await screen.waitForRender()
			screen.press('\x05')
			await screen.waitForRender()
			screen.press('!')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('head tail!', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('inserts newlines with Ctrl+J and enhanced Shift+Enter', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('one')
			screen.press('\n')
			screen.press('two')
			screen.press('\x1b[13;2u')
			screen.press('three')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('one\ntwo\nthree', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('moves vertically by grapheme column and keeps the preferred long column', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('abcdef')
			screen.press('\n')
			screen.press('xy')
			screen.press('\n')
			screen.press('123456')
			await screen.waitForRender()
			screen.press('\x1b[A')
			screen.press('\x10')
			await screen.waitForRender()
			screen.press('!')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('abcdef!\nxy\n123456', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('does not erase an ordinary draft when Down has no line or history to visit', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('keep this')
			await screen.waitForRender()
			screen.press('\x1b[B')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('keep this', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('restores the unsent draft after walking back out of history', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(<Composer history={['older']} onSubmit={submit} />, {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('unsent')
			await screen.waitForRender()
			screen.press('\x1b[A')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('older▏')
			screen.press('\x1b[B')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('unsent▏')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('unsent', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('searches matching history backward and forward without losing the draft', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(
			<Composer
				history={['fix alpha', 'ship beta', 'fix gamma']}
				onSubmit={submit}
			/>,
			{ cols: 100, rows: 16 },
		)
		try {
			screen.press('fix')
			screen.press('\x12')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('fix gamma▏')
			expect(screen.viewport().join('\n')).toContain('history “fix” · 1/2')

			screen.press('\x12')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('fix alpha▏')

			screen.press('\x13')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('fix gamma▏')

			screen.press('\x13')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('fix▏')
			expect(screen.viewport().join('\n')).toContain('draft · 2 matches')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('fix', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('restores the exact draft cursor when Esc leaves history search', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(
			<Composer history={['fix older']} onSubmit={submit} />,
			{ cols: 100, rows: 16 },
		)
		try {
			screen.press('fix')
			screen.press('\x1b[D')
			screen.press('\x12')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('fix older▏')

			screen.press('\x1b')
			await waitUntil(screen, () => !screen.viewport().join('\n').includes('Ctrl+R older'))
			screen.press('X')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('fiXx', undefined)
			expect(screen.viewport().join('\n')).not.toContain('Ctrl+R older')
		} finally {
			await screen.unmount()
		}
	})

	it('restores the unsent draft when search begins from a browsed history entry', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(
			<Composer history={['older prompt']} onSubmit={submit} />,
			{ cols: 100, rows: 16 },
		)
		try {
			screen.press('unsent')
			screen.press('\x1b[A')
			screen.press('\x12')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('history “older prompt” · 1/1')

			screen.press('\x1b')
			await waitUntil(screen, () => !screen.viewport().join('\n').includes('Ctrl+R older'))
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('unsent', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('keeps a no-match search as an editable draft', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(
			<Composer history={['older prompt']} onSubmit={submit} />,
			{ cols: 100, rows: 16 },
		)
		try {
			screen.press('unmatched')
			screen.press('\x12')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('draft · 0 matches')

			screen.press('!')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).not.toContain('Ctrl+R older')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('unmatched!', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('applies Ctrl+W at the cursor while preserving the suffix', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('alpha beta gamma')
			await screen.waitForRender()
			screen.press('\x01')
			await screen.waitForRender()
			for (let index = 0; index < 11; index += 1) screen.press('\x1b[C')
			await screen.waitForRender()
			screen.press('\x17')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('alpha gamma', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('moves by words with Alt+B/F and modified arrows', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('alpha beta')
			screen.press('\x1bb')
			screen.press('X')
			screen.press('\x1b[1;5D')
			screen.press('\x1b[1;5D')
			screen.press('\x1bf')
			screen.press('!')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('alpha! Xbeta', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('deletes the previous or next word at the live cursor', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('alpha beta gamma')
			screen.press('\x1b\x7f')
			screen.press('\x01')
			screen.press('\x1bd')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('beta', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('uses Ctrl+D as forward grapheme deletion without submitting', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('a👍🏽b')
			screen.press('\x01')
			screen.press('\x1b[C')
			screen.press('\x04')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('ab', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('deletes forward at Delete and kills toward either line boundary', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('a👍🏽bc')
			await screen.waitForRender()
			screen.press('\x01')
			screen.press('\x1b[C')
			await screen.waitForRender()
			screen.press('\x1b[3~')
			await screen.waitForRender()
			screen.press('\x05')
			screen.press('\x15')
			await screen.waitForRender()
			screen.press('kept')
			screen.press('\x01')
			screen.press('\x1b[C')
			screen.press('\x0b')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('k', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('yanks the last non-empty kill at the live cursor', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('alpha beta gamma')
			screen.press('\x01')
			for (let index = 0; index < 11; index += 1) screen.press('\x1b[C')
			screen.press('\x17')
			screen.press('\x01')
			screen.press('\x19')
			await screen.waitForRender()
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('beta alpha gamma', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('keeps the kill buffer across submission and treats Ctrl+H as one backspace', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('keep CUT')
			screen.press('\x1bb')
			screen.press('\x0b')
			screen.press('\r')
			await screen.waitForRender()

			screen.press('again ')
			screen.press('\x19')
			screen.press('\x08')
			screen.press('\r')
			await screen.waitForRender()

			expect(submit).toHaveBeenNthCalledWith(1, 'keep', undefined)
			expect(submit).toHaveBeenNthCalledWith(2, 'again CU', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('uses Tab as a queue submission when no completion menu owns it', async () => {
		const submit = vi.fn()
		const screen = await renderToScreen(composer(submit), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('follow up')
			await screen.waitForRender()
			screen.press('\t')
			await screen.waitForRender()

			expect(submit).toHaveBeenCalledWith('follow up', undefined, 'queue')
		} finally {
			await screen.unmount()
		}
	})

	it('gives a slash description the remaining terminal width', async () => {
		const screen = await renderToScreen(composer(vi.fn()), {
			cols: 100,
			rows: 16,
		})
		try {
			screen.press('/per')
			await screen.waitForRender()

			const row = screen.viewport().find((line) => line.includes('/permissions'))
			expect(row).toContain('Choose how undecided tool calls are handled: /permissions [mode].')
		} finally {
			await screen.unmount()
		}
	})

	it('scrolls and runs slash commands after the first six on a burst of Down keys', async () => {
		const matches = matchSlashCommands('/', [])
		expect(matches.length).toBeGreaterThan(7)
		const eighth = matches[7]
		if (!eighth) throw new Error('slash registry unexpectedly has fewer than eight commands')
		const submit = vi.fn()

		const screen = await renderToScreen(composer(submit), {
			cols: 120,
			rows: 24,
		})
		try {
			screen.press('/')
			for (let index = 0; index < 7; index += 1) screen.press('\x1b[B')
			await screen.waitForRender()

			const viewport = screen.viewport().join('\n')
			expect(viewport).toContain(`› /${eighth.name}`)
			expect(viewport).toContain(`8/${matches.length} · ↑↓ navigate`)
			expect(viewport).not.toContain(`› /${matches[0]?.name}`)

			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledWith(`/${eighth.name}`)
		} finally {
			await screen.unmount()
		}
	})

	it('scrolls project files and inserts the selected @ token without sending it', async () => {
		const submit = vi.fn()
		const files = Array.from({ length: 12 }, (_, index) => `src/f${String(index).padStart(2, '0')}.ts`)
		const screen = await renderToScreen(
			<Composer history={[]} mentionCandidates={files} onSubmit={submit} />,
			{
				cols: 120,
				rows: 24,
			},
		)
		try {
			screen.press('@src/f')
			for (let index = 0; index < 7; index += 1) screen.press('\x1b[B')
			await screen.waitForRender()

			const viewport = screen.viewport().join('\n')
			expect(viewport).toContain('› @src/f07.ts')
			expect(viewport).toContain('8/12 · ↑↓ navigate')

			screen.press('\r')
			await screen.waitForRender()
			expect(submit).not.toHaveBeenCalled()
			expect(screen.viewport().join('\n')).toContain('@src/f07.ts ▏')

			screen.press('please')
			screen.press('\r')
			await screen.waitForRender()
			expect(submit).toHaveBeenCalledWith('@src/f07.ts please', undefined)
		} finally {
			await screen.unmount()
		}
	})

	it('jumps through the slash registry with page and boundary keys', async () => {
		const matches = matchSlashCommands('/', [])
		const screen = await renderToScreen(composer(vi.fn()), {
			cols: 120,
			rows: 24,
		})
		try {
			screen.press('/')
			screen.press('\x1b[6~')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain(`› /${matches[6]?.name}`)

			screen.press('\x1b[F')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain(`› /${matches.at(-1)?.name}`)

			screen.press('\x1b[H')
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain(`› /${matches[0]?.name}`)
		} finally {
			await screen.unmount()
		}
	})
})
