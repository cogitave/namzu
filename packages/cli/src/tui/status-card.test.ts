import stringWidth from 'string-width'
import { expect, it } from 'vitest'
import { statusCard } from './status-card.js'

it.each([40, 80, 120])(
	'fits %i columns while retaining full paths and wide characters',
	(columns) => {
		const path = '/home/arda/workspaces/長い名前/namzu/packages/cli'
		const text = statusCard(
			[
				['Directory', path],
				['Model', 'model · low'],
			],
			columns,
		)
		expect(text.split('\n').every((line) => stringWidth(line) <= columns - 6)).toBe(true)
		const values = text
			.split('\n')
			.slice(1, -1)
			.map((line) => line.replace(/^│\s*|\s*│$/g, ''))
			.join('')
		expect(values).toContain(path)
	},
)
