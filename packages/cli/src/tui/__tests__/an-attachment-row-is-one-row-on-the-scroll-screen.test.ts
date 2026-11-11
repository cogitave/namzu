import { expect, it } from 'vitest'

import { messageScrollRows } from '../transcript-scroll.js'

it('draws an attachment as one row, cut to the width, never wrapped', () => {
	const rows = messageScrollRows(
		{
			id: 'm1',
			role: 'user',
			content: 'look [Image #1]',
			attachments: [
				{
					marker: '[Image #1]',
					name: 'very-long-screenshot-name-that-keeps-going-and-going-for-a-while-1234567890.png',
					size: '2.8 KB',
				},
			],
		},
		false,
		70,
	).rows
	expect(rows).toHaveLength(2)
	expect(rows[1]?.text.trim()).toMatch(/^\[Image #1\] very-long.*… · 2\.8 KB$/)
})
