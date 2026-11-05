/**
 * A fenced code block is drawn so that selecting it with the mouse and copying
 * gives the code and nothing else. A rule at the start of each line, or a
 * language word above the first, is on the screen and so in the selection, and
 * what is pasted into a terminal must be the command.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { Markdown } from '../Markdown.js'

const frame = (text: string): string[] =>
	(render(<Markdown text={text} />).lastFrame() ?? '').split('\n').map((line) => line.trimEnd())

describe('a fenced code block', () => {
	it('draws the lines of the code and no glyph beside them', () => {
		const lines = frame('Run this:\n\n```bash\nsudo bash /tmp/install.sh\necho done\n```\n')
		expect(lines).toContain('sudo bash /tmp/install.sh')
		expect(lines).toContain('echo done')
		expect(lines.join('\n')).not.toMatch(/[│┃▎▏|]/u)
	})

	it('carries no language label above the code, which a paste would take for a command', () => {
		const lines = frame('```bash\nls\n```\n')
		expect(lines.filter((line) => line.length > 0)).toEqual(['ls'])
	})

	it('keeps a blank line inside the code as a line', () => {
		const lines = frame('```sh\na\n\nb\n```\n').filter((line, i, all) => i < all.length)
		expect(lines.join('\n')).toContain('a\n\nb')
	})
})
