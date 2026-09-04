import { describe, expect, it } from 'vitest'

import { generateProjectId } from '../../utils/id.js'
import { ProjectIdSchema } from '../schemas.js'

/**
 * The schema the SDK exports for project ids must accept exactly what the SDK
 * mints, and nothing that could double as a path.
 */

describe('every project id the SDK mints passes the schema the SDK exports', () => {
	it('accepts what the id generator produces', () => {
		// 200 draws, because the generator is random over [0-9a-z] and one
		// sample proves nothing about the alphabet it can reach.
		for (let i = 0; i < 200; i++) {
			const id = generateProjectId()
			const parsed = ProjectIdSchema.safeParse(id)
			expect({ id, ok: parsed.success }).toEqual({ id, ok: true })
		}
	})

	it('still refuses what no minter produces, because the id is also a directory name', () => {
		// Widening to accept the legacy form must not widen to accept a path.
		// Everything here would be joined onto the store root if it got through.
		const refused = [
			'prj_../../etc',
			'prj_..',
			'prj_a/b',
			'prj_a\\b',
			'prj_',
			'prj_legacy_',
			// The 0.2 migration's synthesised form. Retired with the migration: one prefix, one shape.
			'prj_legacy_abc',
			'prj_ABC',
			'prj_a-b',
			'prj_a b',
			'proj_abc',
			'thd_abc',
			// NZ-TOPIC-04: the live Topic layer's own prefix must be exactly as
			// unwelcome here as the legacy container's — this schema names
			// Project ids, not Topic ids, and the two must never be mistaken
			// for one another at the validation boundary.
			'top_abc',
			'',
		]

		for (const candidate of refused) {
			const parsed = ProjectIdSchema.safeParse(candidate)
			expect({ candidate, ok: parsed.success }).toEqual({ candidate, ok: false })
		}
	})
})
