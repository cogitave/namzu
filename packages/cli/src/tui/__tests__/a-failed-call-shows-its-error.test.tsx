/**
 * A failed call of an ordinary tool: the error text the tool produced in the
 * error colour, ten lines and then how many more ctrl+o shows; a failure the
 * kernel classed reads as one short sentence with the tool's own message
 * behind ctrl+o.
 */

import { createRequire } from 'node:module'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { theme } from '../theme.js'
import { failureFactsLine, failureFactsTone } from '../tidy-tool-output.js'
import { type ToolEndEvent, toolEndRows } from '../tool-end-rows.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level
beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})

const paletteOf = (color: string) => `palette:${/\((\d+)\)/.exec(color)?.[1]}`
const ERROR_FG = paletteOf(theme.status.error)
const MUTED_FG = paletteOf(theme.text.muted)

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

function failedCall(
	toolName: string,
	output: string | undefined,
	extra: Partial<ToolEndEvent> = {},
): ToolEndEvent {
	return {
		kind: 'tool-end',
		toolUseId: 't1',
		toolName,
		isError: true,
		summary: (output ?? '').split('\n')[0] ?? '',
		...(output !== undefined ? { output } : {}),
		...extra,
	} as ToolEndEvent
}

function rowsOf(event: ToolEndEvent): TranscriptMessage[] {
	const built = toolEndRows(event, { label: `${event.toolName}(x)` }, { hasPlan: false })
	if (built.kind !== 'rows') throw new Error('expected rows')
	return built.rows.map((row, i) => ({ id: `r${i}`, detailRef: i + 1, ...row }))
}

async function draw(messages: TranscriptMessage[], expanded = false) {
	const shown = expanded ? messages.map((m) => ({ ...m, detailExpanded: true })) : messages
	const screen = await renderToScreen(
		<Transcript messages={shown} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols: 100, rows: 60 },
	)
	screens.push(screen)
	await screen.waitForRender()
	return screen
}

const lines = (count: number) => Array.from({ length: count }, (_, i) => `detail ${i + 1}`)

describe('an unclassified failure of an ordinary tool', () => {
	for (const tool of ['web_fetch', 'mcp__files__stat', 'lsp', 'notebook_edit', 'something_else']) {
		it(`${tool} shows "Error: <text>" in the error colour, with no "failed:"`, async () => {
			const screen = await draw(rowsOf(failedCall(tool, 'connection refused')))
			const text = screen.scrollback().join('\n')
			expect(text).toContain('Error: connection refused')
			expect(text).not.toContain('failed:')
			const row = screen.viewport().findIndex((line) => line.includes('Error: connection'))
			expect(screen.cell(row, screen.row(row).indexOf('Error:')).fg).toBe(ERROR_FG)
		})
	}

	it('shows ten lines and then how many more ctrl+o shows; expanded shows them all', async () => {
		const folded = (await draw(rowsOf(failedCall('web_fetch', lines(12).join('\n')))))
			.scrollback()
			.join('\n')
		expect(folded).toContain('detail 10')
		expect(folded).not.toContain('detail 11')
		expect(folded).toContain('… +2 lines (ctrl+o to expand)')
		const full = (await draw(rowsOf(failedCall('web_fetch', lines(12).join('\n'))), true))
			.scrollback()
			.join('\n')
		expect(full).toContain('detail 12')
		expect(full).not.toContain('ctrl+o to expand')
	})

	it('reads "Invalid tool parameters" until expanded', async () => {
		const output = 'InputValidationError: missing "url"'
		const folded = (await draw(rowsOf(failedCall('web_fetch', output)))).scrollback().join('\n')
		expect(folded).toContain('Invalid tool parameters')
		expect(folded).not.toContain('InputValidationError')
		const full = (await draw(rowsOf(failedCall('web_fetch', output)), true)).scrollback().join('\n')
		expect(full).toContain('Error: InputValidationError: missing "url"')
	})

	it('says "Tool execution failed" when the result carries no text', async () => {
		const text = (await draw(rowsOf(failedCall('lsp', undefined, { summary: '' }))))
			.scrollback()
			.join('\n')
		expect(text).toContain('Tool execution failed')
	})
})

describe('a failure the kernel classed', () => {
	it('draws the sentence in the error colour and keeps the tool message behind ctrl+o', async () => {
		const event = failedCall('read', '<tool_use_error>File does not exist.</tool_use_error>', {
			plainFailure: 'Couldn’t find a.ts.',
		})
		const rows = rowsOf(event)
		expect(rows[1]?.content).toBe('Couldn’t find a.ts.')
		expect(rows[1]?.meta).toBe('(ctrl+o to expand)')
		const folded = await draw(rows)
		const text = folded.scrollback().join('\n')
		expect(text).toContain('Couldn’t find a.ts.')
		expect(text).not.toContain('failed:')
		expect(text).not.toContain('File does not exist')
		const row = folded.viewport().findIndex((line) => line.includes('Couldn’t find'))
		expect(folded.cell(row, folded.row(row).indexOf('Couldn’t')).fg).toBe(ERROR_FG)
		const full = (await draw(rows, true)).scrollback().join('\n')
		expect(full).toContain('Error: File does not exist.')
	})

	it('draws advice that a file must be read first dim, not red', async () => {
		const event = failedCall('edit', 'a.ts has not been read yet.', {
			plainFailure: 'Read a.ts first, then try again.',
			plainFailureTone: 'muted',
		})
		const screen = await draw(rowsOf(event))
		const row = screen.viewport().findIndex((line) => line.includes('Read a.ts first'))
		expect(screen.cell(row, screen.row(row).indexOf('Read a.ts')).fg).toBe(MUTED_FG)
	})

	it('words the four edit refusals and tones only the read-first one as advice', () => {
		const facts = (reason: 'not_read' | 'changed_on_disk' | 'text_not_found' | 'not_unique') =>
			({ kind: 'failure', reason, subject: '/w/a.ts' }) as const
		expect(failureFactsLine(facts('not_read'), '/w')).toBe('Read a.ts first, then try again.')
		expect(failureFactsLine(facts('changed_on_disk'), '/w')).toBe(
			'a.ts changed on disk since it was read.',
		)
		expect(failureFactsLine(facts('text_not_found'), '/w')).toBe('Couldn’t find that text in a.ts.')
		expect(failureFactsLine(facts('not_unique'), '/w')).toBe(
			'That text appears more than once in a.ts.',
		)
		expect(failureFactsTone(facts('not_read'))).toBe('muted')
		expect(failureFactsTone(facts('changed_on_disk'))).toBe('error')
	})
})
