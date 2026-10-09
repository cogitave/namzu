import { expect, it } from 'vitest'
import { palDeletionCopy } from './pal-deletion-copy.js'

it('says exactly what is removed and what stays, and where', () => {
	const copy = palDeletionCopy({ name: 'Işık', workspace: '/home/me/.namzu/pals/isik' })
	expect(copy.details).toEqual([
		'Işık disappears from the sidebar and its computer is stopped.',
		'Its conversations and files are not deleted. They stay in /home/me/.namzu/pals/isik.',
	])
	// No sentence repeats another.
	expect(copy.details.join(' ')).not.toMatch(/stored data/)
})
