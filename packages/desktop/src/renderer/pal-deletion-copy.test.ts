import { expect, it } from 'vitest'
import { palDeletionCopy } from './pal-deletion-copy.js'

it('says what is removed and what stays, with the folder path only as a tooltip', () => {
	const copy = palDeletionCopy({ name: 'Işık', workspace: '/home/me/.namzu/pals/isik' })
	expect(copy.details.map((line) => line.text)).toEqual([
		'Işık disappears from the sidebar and its computer is stopped.',
		'Its conversations are not deleted, and Işık’s files stay in its folder.',
	])
	expect(copy.details[1]?.title).toBe('/home/me/.namzu/pals/isik')
	// The path never appears in a visible line, and no sentence repeats another.
	expect(copy.details.map((line) => line.text).join(' ')).not.toContain('/home/me')
})
