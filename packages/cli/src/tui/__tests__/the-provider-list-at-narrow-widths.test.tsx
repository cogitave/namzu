/**
 * The provider list at 40, 60, 80 and 160 columns.
 *
 * The defect: the vendor's name is padded to a fixed 28 columns, so at 40
 * columns the source (`needs OPENROUTER_API_KEY`, `local · localhost:11434`)
 * was given one column and came out one character per line. Below a readable
 * width the source is drawn under the name instead, lined up with it, and every
 * line the screen counts is a line it draws.
 */

import { appendFileSync } from 'node:fs'

import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'
import { type Screen, renderToScreen } from './support/screen.js'

const HOST_INSET = 1

function detected(): readonly DetectedProvider[] {
	return [
		{
			entry: PROVIDER_REGISTRY.ollama,
			source: { kind: 'probe', url: 'http://localhost:11434' },
			alternatives: [],
		},
		{
			entry: PROVIDER_REGISTRY.openrouter,
			source: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		},
	]
}

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function open(
	cols: number,
	rows: number,
	overrides: Partial<Parameters<typeof Picker>[0]> = {},
): Promise<Screen> {
	const screen = await renderToScreen(
		<Box paddingX={HOST_INSET}>
			<Picker
				detected={detected()}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
				onCredential={vi.fn()}
				{...overrides}
			/>
		</Box>,
		{ cols, rows },
	)
	mounted = screen
	await screen.waitForRender()
	if (process.env.PROBE)
		appendFileSync(process.env.PROBE, `--- ${cols}x${rows}\n${screen.viewport().join('\n')}\n`)
	return screen
}

/** The text between the borders of every line the box drew. */
function inside(screen: Screen): string[] {
	return screen
		.viewport()
		.filter((line) => line.includes('│'))
		.map((line) => line.replace(/^[^│]*│/, '').replace(/│[^│]*$/, ''))
}

const WIDTHS = [40, 60, 80, 160] as const

describe.each(WIDTHS)('the provider list at %i columns', (cols) => {
	it('draws every line inside the terminal, with the title and the first row on screen', async () => {
		const screen = await open(cols, 30, { currentProvider: 'ollama' })
		for (const line of screen.viewport()) expect([...line].length).toBeLessThanOrEqual(cols)
		const text = screen.viewport().join('\n')
		expect(text).toContain('Choose a provider')
		expect(text).toContain('Ollama')
		expect(text).toContain('OpenRouter')
	})

	it('never leaves a row with a source one character wide', async () => {
		const screen = await open(cols, 30, { currentProvider: 'ollama' })
		const lines = inside(screen).map((line) => line.trim())
		// A squeezed source is a run of lines that are each one or two characters.
		const fragments = lines.filter((line) => /^\S{1,2}$/.test(line))
		expect(fragments, `squeezed lines at ${cols} columns`).toEqual([])
		expect(lines.join('\n')).toContain('OPENROUTER_API_KEY')
		expect(lines.join('\n')).toContain('localhost:11434')
	})

	it('keeps the names padded to one column only while the source sits beside them', async () => {
		const screen = await open(cols, 30)
		const rows = inside(screen).filter((line) => /^[› ] \d+\. /.test(line.trimStart()))
		const ollama = rows.find((line) => line.includes('Ollama')) ?? ''
		const beside = ollama.includes('localhost')
		expect(beside).toBe(cols >= 80)
	})
})

describe('at 40 columns', () => {
	it('draws a source on its own line under the name, lined up with it', async () => {
		const screen = await open(40, 30, { currentProvider: 'ollama' })
		const lines = inside(screen)
		const at = lines.findIndex((line) => /\d+\. OpenRouter/.test(line))
		expect(at).toBeGreaterThan(-1)
		const name = lines[at] ?? ''
		const under = lines[at + 1] ?? ''
		// The name is not padded out to a column the source is no longer in.
		expect(name.trimEnd()).toMatch(/\d+\. OpenRouter$/)
		// And the source starts under the first letter of the name.
		expect(under.search(/\S/)).toBe(name.search(/OpenRouter/))
		expect(under.trim()).toBe('env · OPENROUTER_API_KEY')
	})

	it('puts the current mark on the name line when it fits, below the source when not', async () => {
		const short = await open(40, 30, { currentProvider: 'ollama' })
		const current = inside(short).filter((line) => line.includes('← current'))
		expect(current).toHaveLength(1)
		expect(current[0]).toContain('Ollama')

		await short.unmount()
		mounted = null
		const long = await open(40, 30, {
			currentProvider: 'openrouter',
			detected: [
				{
					entry: PROVIDER_REGISTRY['lmstudio'],
					source: { kind: 'probe', url: 'http://localhost:1234/v1/models' },
					alternatives: [],
				},
			],
		})
		const marks = inside(long).filter((line) => line.includes('← current'))
		expect(marks.length).toBeLessThanOrEqual(1)
	})

	it('counts the lines it draws: the box fits a short terminal with its title on screen', async () => {
		const screen = await open(40, 16, { currentProvider: 'ollama' })
		const text = screen.viewport().join('\n')
		expect(text).toContain('Choose a provider')
		expect(screen.viewport().length).toBeLessThanOrEqual(16)
	})

	it('draws the providers that are not set up under their names too', async () => {
		const screen = await open(40, 40, { detected: [] })
		const lines = inside(screen).map((line) => line.trim())
		expect(lines.filter((line) => /^\S{1,2}$/.test(line))).toEqual([])
	})
})

describe.each(WIDTHS)('the screen that found no provider at %i columns', (cols) => {
	it('reads its last hint as one paragraph, and hangs a wrapped source under its bullet', async () => {
		const screen = await open(cols, 60, { detected: [], onLogin: vi.fn() })
		const flat = inside(screen)
			.map((line) => line.trim())
			.join(' ')
			.replace(/\s+/g, ' ')
		expect(flat).toContain(
			'You can also set one of the env vars above (or start a local server) and restart.',
		)
		// Every source starts with its bullet or with the two columns that hang under it.
		const lines = inside(screen)
		const at = lines.findIndex((line) => line.includes('· existing'))
		expect(at).toBeGreaterThan(-1)
		const next = lines.slice(at + 1).find((line) => line.trim() !== '') ?? ''
		// `inside` keeps the box's one column of padding in front of each line.
		const body = next.slice(1)
		expect(body.startsWith('· ') || body.startsWith('  ')).toBe(true)
		for (const line of screen.viewport()) expect([...line].length).toBeLessThanOrEqual(cols)
	})
})

describe.each(WIDTHS)(
	'the screen that found no provider on a short terminal at %i columns',
	(cols) => {
		// The box has to leave the line above it (what the app already wrote) and the
		// status bar under it, or the terminal scrolls its top border away. Counted
		// from the drawn box: from its top border to its bottom one.
		it.each(Array.from({ length: 21 }, (_, at) => 30 + at))(
			'is no taller than the terminal less the two lines that are not its own, at %i rows',
			async (rows) => {
				const screen = await open(cols, rows, { detected: [], onLogin: vi.fn() })
				const lines = screen.viewport()
				const top = lines.findIndex((line) => line.includes('╭'))
				const bottom = lines.findIndex((line) => line.includes('╰'))
				const drawn = inside(screen).filter((line) => /^[› ] \d+\. /.test(line.trimStart()))
				// Fewer than two rows is the clamp, where nothing is left to give.
				if (drawn.length < 2) return
				expect(top, 'the top border scrolled away').toBeGreaterThanOrEqual(0)
				expect(bottom - top + 1).toBeLessThanOrEqual(rows - 2)
			},
		)
	},
)

describe.each(WIDTHS)('the model list at %i columns', (cols) => {
	const models = [
		{
			id: 'a/free-one:free',
			name: 'A: A Very Long Model Name (free)',
			inputPrice: 0,
			outputPrice: 0,
		},
		{ id: 'b/paid', name: 'B: Paid Model', inputPrice: 3, outputPrice: 15 },
	]

	it('draws every model row inside the terminal and keeps the title and search on screen', async () => {
		const screen = await open(cols, 24, {
			notice: null,
			currentModel: 'b/paid',
			describeModels: async () => ({ kind: 'ok', models }),
		})
		screen.press('\r')
		await vi.waitFor(async () => {
			await screen.waitForRender()
			expect(screen.viewport().join('\n')).toContain('Search:')
		})
		if (process.env.PROBE)
			appendFileSync(process.env.PROBE, `--- models ${cols}\n${screen.viewport().join('\n')}\n`)
		for (const line of screen.viewport()) expect([...line].length).toBeLessThanOrEqual(cols)
		const text = screen.viewport().join('\n')
		expect(text).toContain('Search:')
		expect(text).toContain('(current)')
		// The count is never glued to the end of the title.
		const title = screen.viewport().find((line) => line.includes('Choose a model')) ?? ''
		expect(title).toMatch(/\S +\d+\/\d+ *│/)
	})
})
