import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXIT_USAGE } from '../exit-codes.js'
import { runLearningCommand } from './learning.js'

const roots: string[] = []
afterEach(() => {
	vi.unstubAllEnvs()
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('namzu learn --sessions', () => {
	it('says there is nothing to learn from when no conversation kept an observation', async () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-learn-'))
		roots.push(home)
		vi.stubEnv('NAMZU_HOME', home)
		const printed: { text?: string }[] = []
		const ctx = {
			formatter: {
				print: (v: { text?: string }) => printed.push(v),
				error: vi.fn(),
				info: vi.fn(),
			},
		}
		const code = await runLearningCommand({
			ctx,
			rawArgs: ['learn', '--sessions', '--cwd', home, 'x.learning.js'],
		} as never)
		expect(code).toBe(EXIT_USAGE)
		expect(printed[0]?.text).toContain('nothing to learn from')
	})
})
