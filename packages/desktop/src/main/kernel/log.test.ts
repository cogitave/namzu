import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFs } from './fs.js'
import { LOG_CAP_BYTES, createKernelLog, scrub } from './log.js'

const folders: string[] = []
afterEach(async () => {
	await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
async function logIn(options: { capBytes?: number; hide?: string[] } = {}) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-log-test-'))
	folders.push(root)
	const path = join(root, 'kernel', 'updates.log')
	const log = createKernelLog({
		fs: nodeFs,
		path,
		now: () => Date.UTC(2026, 10, 12, 10, 0, 0),
		...options,
	})
	return { root, path, log }
}

describe('the engine update log', () => {
	it('writes one JSON object per line, with the time and the event', async () => {
		const { path, log } = await logIn()
		log('check', { result: 'ready', count: 2, flag: true })
		log('marked-bad', { version: '52.0.0', reason: 'it did not start' })
		await log.flush()
		const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{ at: '2026-11-12T10:00:00.000Z', event: 'check', result: 'ready', count: 2, flag: true },
			{
				at: '2026-11-12T10:00:00.000Z',
				event: 'marked-bad',
				version: '52.0.0',
				reason: 'it did not start',
			},
		])
	})

	it('keeps paths, the app data folder and the home folder out of what it writes', async () => {
		const { root, path, log } = await logIn({ hide: ['/data/Person Name/AppData'] })
		log('open-failed', {
			message: `EACCES: permission denied, open '${join(root, 'kernel', 'state.json')}' in /data/Person Name/AppData/x and C:\\Users\\person\\AppData\\Local\\f.txt and \\\\server\\share\\x`,
		})
		await log.flush()
		const text = await readFile(path, 'utf8')
		expect(text).not.toContain(root)
		expect(text).not.toContain('Person Name')
		expect(text).not.toContain('C:\\\\Users')
		expect(text).not.toContain('server')
		expect(text).toContain('<path>')
	})

	it('drops what is not plain text or a number, cuts long text, and strips control characters', () => {
		expect(scrub('a\u0000b\u001bc\nd')).toBe('a b c d')
		expect(scrub('x'.repeat(500))).toHaveLength(201)
		expect(scrub('see /usr/lib/node/x.js now')).toBe('see <path> now')
	})

	it('drops fields that are not strings, numbers or booleans', async () => {
		const { path, log } = await logIn()
		log('check', { fine: 'yes', object: { secret: 1 } as never, list: [1] as never })
		await log.flush()
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
			at: '2026-11-12T10:00:00.000Z',
			event: 'check',
			fine: 'yes',
		})
	})

	it('moves a full file aside and keeps only one older file', async () => {
		const { path, log } = await logIn({ capBytes: 400 })
		for (let i = 0; i < 40; i++) log('check', { result: `run ${i}` })
		await log.flush()
		const current = (await stat(path)).size
		const older = (await stat(`${path}.1`)).size
		expect(current).toBeLessThanOrEqual(400)
		expect(older).toBeLessThanOrEqual(400)
		expect(await stat(`${path}.2`).catch(() => undefined)).toBeUndefined()
		// The newest line is in the current file.
		expect(await readFile(path, 'utf8')).toContain('run 39')
	})

	it('caps at one megabyte by default', () => {
		expect(LOG_CAP_BYTES).toBe(1024 * 1024)
	})

	it('never throws when the file cannot be written', async () => {
		const log = createKernelLog({
			fs: {
				...nodeFs,
				appendFile: async () => {
					throw new Error('disk full')
				},
			},
			path: join(tmpdir(), 'namzu-log-no-such', 'x.log'),
			now: () => 0,
		})
		log('check')
		await expect(log.flush()).resolves.toBeUndefined()
	})
})
