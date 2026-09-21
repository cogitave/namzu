import { z } from 'zod'
import { MEMORY_NAME_MAX_LENGTH } from '../../store/memory/naming.js'

/** The optional typed fields save_memory and update_memory both take. */
export const memoryFieldsSchema = {
	name: z
		.string()
		.max(MEMORY_NAME_MAX_LENGTH)
		.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
		.optional()
		.describe(
			'Unique kebab-case slug, e.g. "deploys-need-a-changeset"; other memories link to it as [[name]]',
		),
	description: z
		.string()
		.max(300)
		.regex(/^[^\r\n]*$/)
		.optional()
		.describe('One line saying what this memory is for, used to decide whether to read it'),
	type: z
		.enum(['user', 'feedback', 'project', 'reference'])
		.optional()
		.describe(
			'user, feedback, project or reference; stores that require a type use project when omitted',
		),
}
