import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { EXIT_USAGE } from '../../exit-codes.js'
import { createFormatter } from '../../output/index.js'
import { getPal, listPals } from '../../pals/store.js'
import { createPalCommand } from '../pal.js'

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-command-'))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})
function command() {
	const formatter = createFormatter('text', { quiet: true })
	const print = vi.spyOn(formatter, 'print').mockImplementation(() => {})
	const error = vi.spyOn(formatter, 'error').mockImplementation(() => {})
	const handler = createPalCommand().handler
	return {
		run: (...rawArgs: string[]) => handler({ ctx: { config: {}, formatter }, rawArgs }),
		print,
		error,
	}
}
it('uses the shared saved store and compare-and-update revisions for metadata commands', async () => {
	const purpose = join(root, 'purpose.txt')
	writeFileSync(purpose, 'Use primary sources.\nSeparate news by model.')
	const c = command()
	expect(
		await c.run('create', 'Research', '--purpose-file', purpose, '--model', 'zen/space-bunny-free'),
	).toBe(0)
	const pal = listPals()[0]
	expect(pal).toMatchObject({
		name: 'Research',
		purpose: 'Use primary sources.\nSeparate news by model.',
		model: { provider: 'zen', model: 'space-bunny-free' },
		revision: 1,
	})
	if (!pal) throw new Error('Expected saved Pal')
	expect(await c.run('update', pal.id, '--revision', '1', '--name', 'Researcher')).toBe(0)
	expect(await c.run('update', pal.id, '--revision', '1', '--purpose', 'Lost edit')).toBe(
		EXIT_USAGE,
	)
	expect(c.error).toHaveBeenLastCalledWith({ message: expect.stringContaining('changed while') })
	expect(getPal(pal.id)?.purpose).toBe(pal.purpose)
	expect(await c.run('pause', pal.id)).toBe(0)
	expect(getPal(pal.id)?.paused).toBe(true)
	expect(await c.run('resume', pal.id)).toBe(0)
	expect(getPal(pal.id)?.paused).toBe(false)
})
it('refuses unknown model providers and ambiguous purpose flags before creating a Pal', async () => {
	const c = command()
	expect(await c.run('create', 'Unknown', '--model', 'unknown-provider/model')).toBe(EXIT_USAGE)
	expect(
		await c.run('create', 'Ambiguous', '--purpose', 'Text', '--purpose-file', 'file.txt'),
	).toBe(EXIT_USAGE)
	expect(listPals()).toEqual([])
})
