/**
 * The detailed transcript, the rewind picker, the tip row and the notice an
 * idle compaction leaves are drawn through the theme tokens only. Under the
 * ANSI-only theme the terminal's own sixteen colours are all that may be asked
 * of it, so a literal 256-colour or 24-bit colour anywhere on them would show
 * as a code of the form `38;5;N` or `38;2;R;G;B`. Under the light theme every
 * colour they use is one the light palette holds.
 */

import { createRequire } from 'node:module'

import { createUserMessage } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { IDLE_COMPACTION_NOTICE } from '../../integrations/compaction/idle-compaction.js'
import { LiveActivity } from '../LiveActivity.js'
import { RewindPicker } from '../RewindPicker.js'
import { Transcript } from '../Transcript.js'
import { TranscriptScreen } from '../TranscriptScreen.js'
import { buildRewindRows, openRewind, rewindOptions } from '../rewind.js'
import { SYSTEM_ROW_GLYPH, systemRowStyle } from '../system-rows.js'
import { resetThemeStore, setThemeSetting } from '../theme-store.js'
import type { TranscriptMessage } from '../types.js'

const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as { level: number }
const originalLevel = chalk.level

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalLevel
})
beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', '3')
	vi.stubEnv('TERM', 'xterm-256color')
})
afterEach(() => {
	vi.unstubAllEnvs()
	resetThemeStore()
})

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches colour escapes in a frame.
const LITERAL_COLOUR = /\u001b\[(?:[0-9;]*;)?(?:38|48);(?:5|2);/

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches colour escapes in a frame.
const NAMED_COLOUR = /\u001b\[(?:3[0-7]|9[0-7])m/

const prompt = (userOrdinal: number, text: string) => ({
	userOrdinal,
	displayText: text,
	message: createUserMessage(text),
})

const rows: TranscriptMessage[] = [
	{ id: 'u', role: 'user', content: 'ask something' },
	{
		id: 'a',
		role: 'assistant',
		content: 'an answer',
		thinking: 'weighing the options',
	},
	{
		id: 't',
		role: 'tool',
		content: 'Searched for 1 pattern',
		glyph: ' ',
		activity: 'exploration',
		detail: ['Search(needle)', 'Error: it failed'],
		meta: '(ctrl+o to expand)',
	},
	{
		id: 's',
		role: 'system',
		content: IDLE_COMPACTION_NOTICE,
		glyph: SYSTEM_ROW_GLYPH,
		glyphColor: systemRowStyle('notice').color,
	},
]
const many: TranscriptMessage[] = Array.from({ length: 34 }, (_, i) => ({
	id: `m${i}`,
	role: 'system' as const,
	content: `row ${i}`,
}))

function surfaces(): Record<string, string> {
	const frames: Record<string, string> = {}
	const grab = (name: string, node: React.ReactElement) => {
		const view = render(node)
		frames[name] = view.lastFrame() ?? ''
		view.unmount()
	}
	grab(
		'the transcript screen',
		<TranscriptScreen
			messages={[...many, ...rows]}
			pending={null}
			rows={80}
			columns={100}
			dialogWaiting
			onClose={() => {}}
		/>,
	)
	const rewindRows = buildRewindRows(
		[prompt(0, 'first prompt'), prompt(1, 'second')],
		undefined,
		[],
	)
	grab(
		'the rewind list',
		<RewindPicker
			rows={rewindRows}
			state={openRewind(rewindRows.length)}
			options={[]}
			checkpointing={false}
			now={0}
		/>,
	)
	const confirm = {
		...openRewind(rewindRows.length),
		stage: 'confirm' as const,
		target: 0,
	}
	grab(
		'the rewind options',
		<RewindPicker
			rows={rewindRows}
			state={confirm}
			options={rewindOptions(true, true)}
			checkpointing
			now={0}
		/>,
	)
	grab('the tips row', <LiveActivity activeTools={[]} working tip="Try /goal to set a result." />)
	grab('the next row', <LiveActivity activeTools={[]} working nextTask="Next: write the tests" />)
	grab(
		'the idle compaction notice',
		<Transcript messages={rows} pending={null} state="idle" settled={0} resetKey={0} />,
	)
	return frames
}

describe('the newest screens', () => {
	it('ask for no literal colour under the ANSI-only theme', () => {
		setThemeSetting('dark-ansi', { env: {} })
		for (const [name, frame] of Object.entries(surfaces())) {
			expect(frame, `${name} drew no named colour`).toMatch(NAMED_COLOUR)
			expect(frame, `${name} asked for a literal colour`).not.toMatch(LITERAL_COLOUR)
		}
	})

	it('draw the light theme in the light palette and nothing from the dark one', () => {
		setThemeSetting('light', { env: {} })
		for (const [name, frame] of Object.entries(surfaces())) {
			// Dark's primary text, muted text and user accent.
			for (const dark of ['38;5;252m', '38;5;245m', '38;5;83m']) {
				expect(frame, `${name} drew a dark-theme colour (${dark})`).not.toContain(dark)
			}
		}
	})
})
