/**
 * What the local settings writer and the move do when the disk or another
 * writer does something in the middle of a step: a write that takes fewer
 * bytes than asked, a write that says it took them all and did not, a lock
 * whose owner cannot be written, another writer replacing the file while this
 * one is saving, and an older Namzu writing the earlier file while it is being
 * moved. Each is made to happen at an exact step through `node:fs`, so nothing
 * here depends on timing; in every case no saved setting is lost.
 */

import {
	type PathLike,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	LEGACY_LOCAL_CONFIG_FILE,
	legacyLocalConfigPath,
	localSettingsPath,
	moveLegacyLocalConfig,
	updateLocalSettings,
	writeLocalAllows,
} from '../local-settings.js'

type WriteSync = (fd: number, buffer: Buffer, offset?: number, length?: number) => number
type RenameSync = (from: PathLike, to: PathLike) => void

const seam = vi.hoisted(() => ({
	writeSync: undefined as undefined | ((real: WriteSync, ...args: Parameters<WriteSync>) => number),
	renameSync: undefined as undefined | ((real: RenameSync, from: string, to: string) => void),
}))

vi.mock('node:fs', async (importOriginal) => {
	const real = await importOriginal<typeof import('node:fs')>()
	const writeSync = ((fd: number, buffer: Buffer, offset?: number, length?: number) =>
		seam.writeSync
			? seam.writeSync(real.writeSync as WriteSync, fd, buffer, offset, length)
			: (real.writeSync as WriteSync)(fd, buffer, offset, length)) as typeof real.writeSync
	const renameSync = ((from: PathLike, to: PathLike) =>
		seam.renameSync
			? seam.renameSync(real.renameSync, String(from), String(to))
			: real.renameSync(from, to)) as typeof real.renameSync
	return { ...real, default: { ...real, writeSync, renameSync }, writeSync, renameSync }
})

const roots: string[] = []
afterEach(() => {
	seam.writeSync = undefined
	seam.renameSync = undefined
	for (const root of roots.splice(0)) removeTempDir(root)
})

function folder(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-local-writes-'))
	roots.push(root)
	return root
}

/** A local file holding `count` saved answers, a few kilobytes. */
function savedAnswers(cwd: string, count: number): Buffer {
	const bash: Record<string, string> = {}
	for (let n = 0; n < count; n += 1) bash[`echo answer-${n} *`] = 'allow'
	const bytes = Buffer.from(`${JSON.stringify({ permissions: { bash } }, null, '\t')}\n`)
	mkdirSync(join(cwd, '.namzu'), { recursive: true })
	writeFileSync(localSettingsPath(cwd), bytes)
	return bytes
}

const OLD = Buffer.from(
	'{\n\t"permissions": {\n\t\t"bash": {\n\t\t\t"npm test *": "allow"\n\t\t}\n\t}\n}\n',
)

describe('a write the disk cuts short', () => {
	it('keeps writing until every byte is down', () => {
		const cwd = folder()
		savedAnswers(cwd, 120)
		// At most 512 bytes per call, as a nearly full disk or a pipe may answer.
		seam.writeSync = (real, fd, buffer, offset = 0, length = buffer.length - offset) =>
			real(fd, buffer, offset, Math.min(length, 512))

		const write = writeLocalAllows(cwd, { bash: { 'echo one-more *': 'allow' } })

		expect(write.error).toBeUndefined()
		const saved = JSON.parse(readFileSync(localSettingsPath(cwd), 'utf8')) as {
			permissions: { bash: Record<string, string> }
		}
		expect(Object.keys(saved.permissions.bash)).toHaveLength(121)
		expect(saved.permissions.bash['echo one-more *']).toBe('allow')
	})

	it('leaves the saved file whole when the disk takes no more', () => {
		const cwd = folder()
		const before = savedAnswers(cwd, 120)
		let total = 0
		seam.writeSync = (real, fd, buffer, offset = 0, length = buffer.length - offset) => {
			const room = Math.max(0, 2048 - total)
			if (room === 0) return 0
			const written = real(fd, buffer, offset, Math.min(length, room))
			total += written
			return written
		}

		const write = writeLocalAllows(cwd, { bash: { 'echo one-more *': 'allow' } })

		expect(write.error).toMatch(/the disk took \d+ of \d+ bytes/)
		expect(readFileSync(localSettingsPath(cwd)).equals(before)).toBe(true)
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['settings.local.json'])
	})

	it('never renames a copy that does not read back as what was written', () => {
		const cwd = folder()
		const before = savedAnswers(cwd, 120)
		// Says it took everything, keeps half: the read-back before the rename catches it.
		seam.writeSync = (real, fd, buffer, offset = 0, length = buffer.length - offset) => {
			real(fd, buffer, offset, Math.ceil(length / 2))
			return length
		}

		const write = writeLocalAllows(cwd, { bash: { 'echo one-more *': 'allow' } })

		expect(write.error).toMatch(/not what was written/)
		expect(readFileSync(localSettingsPath(cwd)).equals(before)).toBe(true)
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['settings.local.json'])
	})
})

describe('the lock', () => {
	it('is not left behind when its owner cannot be written into it', () => {
		const cwd = folder()
		const before = savedAnswers(cwd, 3)
		let first = true
		seam.writeSync = (real, fd, buffer, offset, length) => {
			if (first) {
				first = false
				throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
					code: 'ENOSPC',
				})
			}
			return real(fd, buffer, offset, length)
		}

		const write = updateLocalSettings(cwd, () => ({ document: { quiet: true } }), {
			lockWaitMs: 0,
		})

		expect(write.error).toMatch(/lock could not be written \(ENOSPC/)
		expect(write.error).not.toMatch(/another Namzu/)
		expect(existsSync(`${localSettingsPath(cwd)}.lock`)).toBe(false)
		expect(readFileSync(localSettingsPath(cwd)).equals(before)).toBe(true)
		// The next write finds no lock in its way.
		expect(
			updateLocalSettings(cwd, () => ({ document: { quiet: true } }), { lockWaitMs: 0 }).error,
		).toBeUndefined()
	})
})

describe('a lock taken over while its writer was paused', () => {
	it('is left to the writer that took it over', () => {
		const cwd = folder()
		savedAnswers(cwd, 3)
		const lock = `${localSettingsPath(cwd)}.lock`
		const theirs = JSON.stringify({ pid: 1, host: 'elsewhere', at: '2026-01-01T00:00:00.000Z' })
		let done = false
		seam.writeSync = (real, fd, buffer, offset, length) => {
			if (!done && buffer.includes('echo mine')) {
				done = true
				writeFileSync(lock, theirs)
			}
			return real(fd, buffer, offset, length)
		}

		expect(writeLocalAllows(cwd, { bash: { 'echo mine *': 'allow' } }).error).toBeUndefined()
		expect(readFileSync(lock, 'utf8')).toBe(theirs)
	})
})

describe('another writer while this one saves', () => {
	it('leaves the newer file alone instead of putting an older view over it', () => {
		const cwd = folder()
		savedAnswers(cwd, 3)
		const newer = '{"permissions":{"bash":{"written by the other *":"allow"}}}\n'
		// A writer that took the lock over while this one was paused saves while this one
		// writes its staging file.
		let done = false
		seam.writeSync = (real, fd, buffer, offset, length) => {
			if (!done && buffer.includes('echo mine')) {
				done = true
				writeFileSync(localSettingsPath(cwd), newer)
			}
			return real(fd, buffer, offset, length)
		}

		const write = writeLocalAllows(cwd, { bash: { 'echo mine *': 'allow' } })

		// The check runs before the rename, so the rename that would replace it never happens.
		expect(write.error).toMatch(/changed while this was being saved/)
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(newer)
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['settings.local.json'])
	})
})

describe('an older Namzu writing the earlier file during the move', () => {
	it('keeps a change made just before the old file steps aside, and drops the stale copy', () => {
		const cwd = folder()
		writeFileSync(legacyLocalConfigPath(cwd), OLD)
		const changed = '{"permissions":{"bash":{"npm test *":"allow","git log *":"allow"}}}\n'
		seam.renameSync = (real, from, to) => {
			if (from === legacyLocalConfigPath(cwd)) writeFileSync(from, changed)
			real(from, to)
		}

		const move = moveLegacyLocalConfig(cwd)

		expect(move).toMatchObject({ state: 'kept', why: 'changed' })
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(changed)
		// The copy held the old answers only: it went, and so did the .namzu made for it.
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
		expect(readdirSync(cwd)).toEqual([LEGACY_LOCAL_CONFIG_FILE])

		// The next start moves what the old file holds now.
		seam.renameSync = undefined
		expect(moveLegacyLocalConfig(cwd).state).toBe('moved')
		expect(readFileSync(localSettingsPath(cwd), 'utf8')).toBe(changed)
	})

	it('keeps a change made just after the old file stepped aside, as the old file', () => {
		const cwd = folder()
		writeFileSync(legacyLocalConfigPath(cwd), OLD)
		const later = '{"permissions":{"bash":{"npm test *":"allow","git diff *":"allow"}}}\n'
		seam.renameSync = (real, from, to) => {
			real(from, to)
			if (from === legacyLocalConfigPath(cwd)) writeFileSync(from, later)
		}

		const move = moveLegacyLocalConfig(cwd)

		// What was moved is what was copied; the newer write is a file of its own, still read.
		expect(move.state).toBe('moved')
		expect(readFileSync(localSettingsPath(cwd)).equals(OLD)).toBe(true)
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(later)
		expect(readdirSync(cwd).sort()).toEqual(['.namzu', LEGACY_LOCAL_CONFIG_FILE])
	})

	it('keeps both versions when the old file changed twice during the move', () => {
		const cwd = folder()
		writeFileSync(legacyLocalConfigPath(cwd), OLD)
		const first = '{"permissions":{"bash":{"first *":"allow"}}}\n'
		const second = '{"permissions":{"bash":{"first *":"allow","second *":"allow"}}}\n'
		seam.renameSync = (real, from, to) => {
			if (from !== legacyLocalConfigPath(cwd)) return real(from, to)
			writeFileSync(from, first)
			real(from, to)
			writeFileSync(from, second)
		}

		const move = moveLegacyLocalConfig(cwd)

		expect(move).toMatchObject({ state: 'kept', why: 'changed' })
		expect(readFileSync(legacyLocalConfigPath(cwd), 'utf8')).toBe(second)
		// The version before it is kept inside .namzu, under a name git ignores with the local file.
		expect(readdirSync(cwd).sort()).toEqual(['.namzu', LEGACY_LOCAL_CONFIG_FILE])
		const aside = readdirSync(join(cwd, '.namzu'))
		expect(aside).toHaveLength(1)
		expect(aside[0]).toMatch(/^settings\.local\.json\.moving\.\d+\.[0-9a-f]+$/)
		expect(move.state === 'kept' && move.sentence).toContain(`.namzu/${aside[0]}`)
		expect(readFileSync(join(cwd, '.namzu', aside[0] as string), 'utf8')).toBe(first)
		expect(existsSync(localSettingsPath(cwd))).toBe(false)
	})
})
