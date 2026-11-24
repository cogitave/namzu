/**
 * The `imageGeneration.enabled: false` switch only holds where the setting
 * reaches the session, so every host that builds its own options carries it.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('imageGeneration reaches every session host', () => {
	for (const file of [
		'commands/drain.ts',
		'commands/learn-builtin.ts',
		'pals/dispatch.ts',
		'schedule/fire/fire.ts',
	]) {
		it(`${file} passes the setting`, () => {
			expect(readFileSync(join(src, file), 'utf8')).toMatch(
				/imageGeneration: \w+(\.config)?\.imageGeneration/,
			)
		})
	}
})
