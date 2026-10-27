import { Box } from 'ink'
import stringWidth from 'string-width'
import { describe, expect, it } from 'vitest'

import {
	TrustPrompt,
	trustChoiceRows,
	trustPathWidth,
	trustSentenceLines,
	trustTitleLines,
} from '../TrustPrompt.js'
import { boxedContentWidth } from '../key-hints.js'
import { wrapBalancedText, wrapChoiceText } from '../terminal-choice-text.js'
import { renderToScreen } from './support/screen.js'

const WIDTHS = Array.from({ length: 81 }, (_, at) => 40 + at)

function paragraphs(columns: number): readonly (readonly string[])[] {
	return [trustTitleLines(columns), ...trustSentenceLines(columns)]
}

describe('trust prompt text', () => {
	it('uses the box real content width', () => {
		// Two columns of host inset, two of border, four of padding.
		expect(trustPathWidth(54)).toBe(46)
		expect(boxedContentWidth(54, 2)).toBe(46)
		expect(boxedContentWidth(54, 1)).toBe(48)
	})

	it('does not leave "files" alone at 54 columns', () => {
		const [capability] = trustSentenceLines(54)
		expect(capability).toEqual([
			'namzu can read, run commands in,',
			'and edit files in this folder.',
		])
	})

	for (const columns of WIDTHS) {
		it(`fits ${columns} columns with no orphan word`, () => {
			const width = trustPathWidth(columns)
			for (const lines of paragraphs(columns)) {
				for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width)
				if (lines.length < 2) continue
				const last = lines[lines.length - 1] ?? ''
				const before = lines[lines.length - 2] ?? ''
				// The last line is never one short word under a line that has room for it.
				if (!last.includes(' ') && stringWidth(last) <= 10) {
					expect(stringWidth(`${before} ${last}`)).toBeGreaterThan(width)
				}
			}
			for (const [yes, no] of trustChoiceRows(columns)) {
				expect(stringWidth(yes && no ? `${yes} · ${no}` : yes || no)).toBeLessThanOrEqual(width)
			}
		})
	}

	it('uses no more lines than a greedy wrap', () => {
		for (const columns of WIDTHS) {
			const width = trustPathWidth(columns)
			for (const sentence of [
				'Do you trust the files in this folder?',
				'Only continue if you trust its contents.',
			]) {
				expect(wrapBalancedText(sentence, width).length).toBe(
					wrapChoiceText(sentence, width).length,
				)
			}
		}
	})
})

describe('trust prompt on screen', () => {
	for (const columns of [40, 54, 60, 80, 120]) {
		it(`draws every wrapped line whole at ${columns} columns`, async () => {
			const screen = await renderToScreen(
				// The app draws screens inside a one-column inset on each side.
				<Box paddingX={1}>
					<TrustPrompt cwd="/srv/app" />
				</Box>,
				{ cols: columns, rows: 30 },
			)
			try {
				const frame = screen.viewport().map((row) => row.trimEnd())
				for (const row of frame) expect(stringWidth(row)).toBeLessThanOrEqual(columns)
				for (const lines of paragraphs(columns)) {
					const start = frame.findIndex((row) => row.includes(lines[0] ?? '\u0000'))
					expect(start).toBeGreaterThanOrEqual(0)
					lines.forEach((line, at) => expect(frame[start + at]).toContain(line))
				}
			} finally {
				await screen.unmount()
			}
		})
	}
})

describe('what the folder pre-approves is said before the choice', () => {
	it('draws nothing for a folder that grants nothing', async () => {
		const { trustGrantLines } = await import('../TrustPrompt.js')
		expect(trustGrantLines(undefined, 80)).toEqual([])
		expect(trustGrantLines({ allowRules: [], directories: [], toolServers: [] }, 80)).toEqual([])
	})

	it('lists at most eight rules, counts the rest, and names the added folders', async () => {
		const { trustGrantLines } = await import('../TrustPrompt.js')
		const lines = trustGrantLines(
			{
				allowRules: Array.from({ length: 10 }, (_, i) => `rule${i}`),
				directories: ['../shared'],
				toolServers: [],
			},
			80,
		)
		expect(lines[0]).toBe('This folder allows 10 actions without asking:')
		expect(lines.filter((line) => /^ {2}rule\d$/.test(line))).toHaveLength(8)
		expect(lines).toContain('  and 2 more')
		expect(lines).toContain('This folder adds 1 folder to the workspace:')
		expect(lines).toContain('  ../shared')
		expect(lines.join(' ')).toContain('These will apply without asking.')
	})

	it('names the tool servers the folder would start', async () => {
		const { trustGrantLines } = await import('../TrustPrompt.js')
		const lines = trustGrantLines(
			{ allowRules: [], directories: [], toolServers: ['tickets', 'docs'] },
			80,
		)
		expect(lines).toContain('This folder starts 2 tool servers:')
		expect(lines).toContain('  tickets')
		expect(lines).toContain('  docs')
	})

	it('is drawn above the choice', async () => {
		const screen = await renderToScreen(
			<TrustPrompt
				cwd="/srv/app"
				grants={{ allowRules: ['bash(git status *)'], directories: [], toolServers: [] }}
			/>,
			{ cols: 100, rows: 30 },
		)
		try {
			const text = screen.viewport().join('\n')
			expect(text).toContain('This folder allows 1 action without asking:')
			expect(text).toContain('bash(git status *)')
			expect(text.indexOf('bash(git status *)')).toBeLessThan(text.indexOf('y trust this folder'))
		} finally {
			await screen.unmount()
		}
	})
})
