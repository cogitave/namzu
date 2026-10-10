/**
 * The copy, edit and resume pickers draw their key line on one row and keep
 * the key that leaves, at the widths a person's terminal really has.
 *
 * Found in a real terminal: at 40 columns the edit picker lost `enter` and
 * `esc` altogether and the copy picker wrapped `esc cancel` onto a second row
 * (the width it fitted to ignored the host's inset).
 */

import { Box } from 'ink'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'

import { CopyPicker } from '../CopyPicker.js'
import { EditPromptPicker } from '../EditPromptPicker.js'
import { ResumePicker } from '../ResumePicker.js'
import { renderToScreen } from './support/screen.js'

const pickers: readonly (readonly [string, () => ReactNode, RegExp])[] = [
	[
		'copy',
		() => (
			<CopyPicker
				targets={[{ kind: 'response', label: 'Latest response', text: 'hello' } as any]}
				selected={0}
			/>
		),
		/enter/,
	],
	[
		'edit',
		() => (
			<EditPromptPicker
				prompts={[{ userOrdinal: 1, displayText: 'first', message: { role: 'user' } } as any]}
				selected={0}
			/>
		),
		/enter/,
	],
	[
		'resume',
		() => (
			<ResumePicker
				conversations={[
					{
						id: 'a',
						title: 'T',
						named: true,
						updatedAt: new Date(0).toISOString(),
						count: 1,
					} as any,
				]}
				selected={0}
			/>
		),
		/enter/,
	],
]

describe.each(pickers)('the %s picker key line', (_name, picker, enter) => {
	it.each([40, 50, 60, 80, 116, 160])(
		'is one row with enter and esc at %i columns',
		async (cols) => {
			const screen = await renderToScreen(<Box paddingX={1}>{picker()}</Box>, { cols, rows: 24 })
			try {
				await screen.waitForRender()
				const view = screen.viewport().filter((line) => line.trim() !== '')
				const text = view.join('\n')
				const bottom = view.findIndex((line) => line.includes('╰'))
				expect(bottom, text).toBeGreaterThan(0)
				const key = view[bottom - 1] ?? ''
				// The row above the border is the key row and the one above that is not a
				// continuation of it: it holds a list row or the blank before it.
				expect(key, text).toMatch(enter)
				expect(key, text).toMatch(/\besc\b/)
				expect(key.replace(/[│\s]+$/, ''), text).not.toMatch(/[·]\s*$/)
			} finally {
				await screen.unmount()
			}
		},
	)
})
