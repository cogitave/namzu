import { createHash } from 'node:crypto'
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { TenantId } from '../types/ids/index.js'
import { generateTenantId } from '../utils/id.js'
import {
	DiskLearningGuidance,
	LearningGuidanceConflictError,
	earlierGuidanceDirectory,
} from './guidance.js'

/**
 * Written by the store that kept guidance before it had a store of its own: a
 * real four-revision history (create, an unrelated pursuit, a profile change,
 * an evaluated skill activation), copied from disk, not rebuilt by hand.
 */
const EARLIER = fileURLToPath(new URL('./__fixtures__/earlier-guidance', import.meta.url))
const TENANT = '0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8' as TenantId
const SCOPE = { tenantId: TENANT, agentKey: 'sessions' }

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scratch(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-guidance-'))
	roots.push(root)
	return root
}
function earlierCopy(): string {
	const root = scratch()
	cpSync(EARLIER, root, { recursive: true })
	return root
}
function digests(directory: string): Record<string, string> {
	const out: Record<string, string> = {}
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) walk(path)
			else
				out[path.slice(directory.length)] = createHash('sha256')
					.update(readFileSync(path))
					.digest('hex')
		}
	}
	walk(directory)
	return out
}

const evidence = (key: string) => ({
	key,
	source: 'fixture:trace',
	reason: 'A fixture correction.',
})

describe('learning guidance', () => {
	it('creates one empty first revision and refuses a second creator', async () => {
		const guidance = new DiskLearningGuidance(scratch(), {
			tenantId: generateTenantId(),
			agentKey: 'a',
		})
		expect(await guidance.read()).toBeNull()
		const first = await guidance.create()
		expect(first).toMatchObject({ revision: 1 })
		await expect(guidance.create()).rejects.toBeInstanceOf(LearningGuidanceConflictError)
		expect(await guidance.open()).toEqual(first)
	})

	it('changes guidance only against the revision it read', async () => {
		const guidance = new DiskLearningGuidance(scratch(), {
			tenantId: generateTenantId(),
			agentKey: 'a',
		})
		const first = await guidance.open()
		const second = await guidance.updateProfile(first, {
			identity: 'Prefers short answers.',
			evidence: evidence('one'),
		})
		expect(second.revision).toBe(2)
		await expect(
			guidance.updateProfile(first, { identity: 'Another.', evidence: evidence('two') }),
		).rejects.toBeInstanceOf(LearningGuidanceConflictError)
		expect((await guidance.readRevision(1))?.learning).toBeUndefined()
		expect((await guidance.readRevision(2))?.learning?.identity?.text).toBe(
			'Prefers short answers.',
		)
	})

	it('refuses a record written for another tenant or scope key', async () => {
		const root = scratch()
		const writer = new DiskLearningGuidance(root, { tenantId: generateTenantId(), agentKey: 'a' })
		await writer.create()
		const reader = new DiskLearningGuidance(root, { tenantId: generateTenantId(), agentKey: 'a' })
		await expect(reader.read()).rejects.toThrow(/does not match/)
	})
})

describe('guidance kept before learning had its own store', () => {
	it('is carried over with every revision, and the earlier files are left exactly as they were', async () => {
		const old = earlierCopy()
		const before = digests(old)
		const directory = join(scratch(), 'guidance')
		const guidance = new DiskLearningGuidance(directory, SCOPE, {
			adoptFrom: earlierGuidanceDirectory(old, SCOPE),
		})

		const head = await guidance.read()
		expect(head?.revision).toBe(4)
		expect(head?.learning?.skills.map((s) => s.name)).toEqual(['inspect-source'])
		expect(head?.learning?.identity?.text).toBe('Prefers short answers.')
		expect(head?.learning?.preferences.map((p) => p.key)).toEqual(['tone'])

		// History survives with its numbers, so an older revision can still be restored.
		expect((await guidance.readRevision(1))?.learning).toBeUndefined()
		expect((await guidance.readRevision(3))?.learning?.skills).toEqual([])
		expect((await guidance.readRevision(3))?.learning?.preferences).toHaveLength(1)

		expect(existsSync(join(directory, 'adopted.json'))).toBe(true)
		expect(digests(old)).toEqual(before)
	})

	it('keeps working on top of what was carried over, without touching the earlier store', async () => {
		const old = earlierCopy()
		const before = digests(old)
		const directory = join(scratch(), 'guidance')
		const adoptFrom = earlierGuidanceDirectory(old, SCOPE)
		const guidance = new DiskLearningGuidance(directory, SCOPE, { adoptFrom })
		const head = await guidance.open()

		const next = await guidance.updateProfile(head, {
			preferences: [{ key: 'tone', value: 'formal', supersedes: 'profile-1' }],
			evidence: evidence('after-upgrade'),
		})
		expect(next.revision).toBe(5)
		const restored = await guidance.rollbackSkill(next, 'inspect-source', 3, evidence('undo'))
		expect(restored.revision).toBe(6)
		expect(restored.learning?.skills.find((s) => s.name === 'inspect-source')).toBeUndefined()

		// A second process, or a restart, sees the same head and copies nothing again.
		const reopened = new DiskLearningGuidance(directory, SCOPE, { adoptFrom })
		expect((await reopened.read())?.revision).toBe(6)
		expect(digests(old)).toEqual(before)
		expect(readdirSync(join(directory, 'revisions')).sort()).toEqual(
			['1.json', '2.json', '3.json', '4.json', '5.json', '6.json'].sort(),
		)
	})

	it('is carried over once when two processes first use the store together', async () => {
		const old = earlierCopy()
		const directory = join(scratch(), 'guidance')
		const adoptFrom = earlierGuidanceDirectory(old, SCOPE)
		const heads = await Promise.all(
			[1, 2, 3].map(() => new DiskLearningGuidance(directory, SCOPE, { adoptFrom }).read()),
		)
		expect(heads.map((h) => h?.revision)).toEqual([4, 4, 4])
	})

	it('is not carried over, and not marked, when its history has a gap', async () => {
		const old = earlierCopy()
		const adoptFrom = earlierGuidanceDirectory(old, SCOPE)
		rmSync(join(adoptFrom, 'revisions', '3.json'))
		const directory = join(scratch(), 'guidance')
		const guidance = new DiskLearningGuidance(directory, SCOPE, { adoptFrom })
		await expect(guidance.read()).rejects.toThrow(/gaps/)
		expect(existsSync(join(directory, 'adopted.json'))).toBe(false)
	})

	it('does nothing when there was no earlier store', async () => {
		const directory = join(scratch(), 'guidance')
		const guidance = new DiskLearningGuidance(directory, SCOPE, {
			adoptFrom: earlierGuidanceDirectory(scratch(), SCOPE),
		})
		expect(await guidance.read()).toBeNull()
		expect(existsSync(directory)).toBe(false)
	})

	it('refuses earlier history that belongs to another scope key', async () => {
		const old = earlierCopy()
		const directory = join(scratch(), 'guidance')
		const guidance = new DiskLearningGuidance(
			directory,
			{ tenantId: TENANT, agentKey: 'other' },
			{ adoptFrom: earlierGuidanceDirectory(old, SCOPE) },
		)
		await expect(guidance.read()).rejects.toThrow(/does not match/)
	})
})
