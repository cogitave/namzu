import { afterEach, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { ShellOutput } from '../shell-cell.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const screens: Screen[] = []
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

const stdout = Array.from({ length: 40 }, (_, i) => `satir ${i + 1}`)

function cell(shell: ShellOutput, content = 'Bash(seq 40)', glyphColor = '#00ff00') {
	const message: TranscriptMessage = {
		id: 'one',
		role: 'tool',
		content,
		glyph: '●',
		glyphColor,
		detail: [...shell.stdout, ...shell.stderr],
		detailRef: 1,
		shell,
	}
	return message
}

async function draw(message: TranscriptMessage, cols = 80) {
	const screen = await renderToScreen(
		<Transcript messages={[message]} pending={null} state="idle" settled={0} resetKey={0} />,
		{ cols, rows: 60 },
	)
	screens.push(screen)
	await screen.waitForRender()
	return screen.scrollback().join('\n')
}

it('draws a dot, a hung ⎿ result, the first three lines and the fold', async () => {
	const text = await draw(cell({ stdout, stderr: [], failed: false }))
	expect(text).toContain('● Bash(seq 40)')
	expect(text).toMatch(
		/⎿ {2}satir 1\n {5}satir 2\n {5}satir 3\n {5}… \+37 lines \(ctrl\+o to expand\)/,
	)
	expect(text).not.toContain('satir 4')
	expect(text).not.toContain('▏')
	expect(text).not.toContain('not shown')
	expect(text).not.toMatch(/· \d/)
})

it('shows stderr and the exit status for a failed command', async () => {
	const text = await draw(
		cell(
			{ stdout: [], stderr: ['hata-mesaji'], failed: true, status: 'Exit code 3' },
			'Bash(echo hata-mesaji >&2; exit 3)',
			'#ff0000',
		),
	)
	expect(text).toMatch(/⎿ {2}Exit code 3\n {5}hata-mesaji/)
})

it('says (No output) for a command that printed nothing', async () => {
	const text = await draw(cell({ stdout: [], stderr: [], failed: false }, 'Bash(true)'))
	expect(text).toContain('⎿  (No output)')
})

it('keeps the header line breaks and shows the whole command and output when expanded', async () => {
	const shell: ShellOutput = {
		stdout,
		stderr: [],
		failed: false,
		fullHeader: "Bash(cat <<'EOF'\nbir\niki\nEOF)",
	}
	const collapsed = await draw(cell(shell, "Bash(cat <<'EOF'\nbir…)"))
	expect(collapsed).toContain("● Bash(cat <<'EOF'\n  bir…)")
	const screen = await renderToScreen(
		<Transcript
			messages={[{ ...cell(shell, "Bash(cat <<'EOF'\nbir…)"), detailExpanded: true }]}
			pending={null}
			state="idle"
			settled={0}
			resetKey={0}
		/>,
		{ cols: 80, rows: 60 },
	)
	screens.push(screen)
	await screen.waitForRender()
	const text = screen.scrollback().join('\n')
	expect(text).toContain('iki')
	expect(text).toContain('EOF)')
	expect(text).toContain('satir 40')
	expect(text).not.toContain('ctrl+o to expand')
})
