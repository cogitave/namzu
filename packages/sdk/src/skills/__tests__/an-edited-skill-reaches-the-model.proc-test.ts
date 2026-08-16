import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { SkillRegistry } from '../registry.js'

/**
 * An edited SKILL.md, reaching the model without a restart.
 *
 * The cache was permanent: once a body had been read, `existing.body`
 * short-circuited every later `load`, so editing a skill required
 * restarting the process. That is tolerable for a one-shot run and wrong
 * for a long-lived one — a skill is a file an author edits WHILE the agent
 * is running, which is the whole reason it is a file and not a constant.
 *
 * Process-level: every property here is about a real file's mtime and size,
 * and a stubbed `stat` would prove only that the stub was called.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function skillDir(body: string, name = 'reconcile'): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-skill-edit-'))
	dirs.push(root)
	const dir = join(root, name)
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, 'SKILL.md'),
		`---\nname: ${name}\ndescription: reconcile two ledgers\n---\n\n${body}\n`,
		'utf-8',
	)
	return dir
}

async function rewrite(dir: string, body: string, name = 'reconcile'): Promise<void> {
	await writeFile(
		join(dir, 'SKILL.md'),
		`---\nname: ${name}\ndescription: reconcile two ledgers\n---\n\n${body}\n`,
		'utf-8',
	)
}

describe('an edited skill is re-read', () => {
	it('serves the new body on the next load', async () => {
		// The regression, straight. Before this the second load returned the
		// first body forever.
		const dir = await skillDir('THE FIRST BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		const first = await registry.load('reconcile')

		await rewrite(dir, 'THE SECOND BODY')
		const second = await registry.load('reconcile')

		expect(first?.skill.body).toContain('THE FIRST BODY')
		expect(second?.skill.body).toContain('THE SECOND BODY')
	})

	it('does NOT re-read a file nobody touched', async () => {
		// The other half: a cache that reloads on every lookup is not a cache,
		// and this one is read on the model's path. Detected by identity — an
		// unchanged read hands back the same object.
		const dir = await skillDir('THE BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		// One warm-up: `register` defaults to metadata-only, so the first
		// `load` legitimately reads the body it does not yet have.
		await registry.load('reconcile')

		const first = await registry.load('reconcile')
		const second = await registry.load('reconcile')

		expect(first?.skill).toBe(second?.skill)
	})

	it('stamps at REGISTER, so the first load is already a cache hit', async () => {
		// Without a stamp at registration the first `load` re-reads a file
		// nothing has touched — invisible in the content and a wasted read on
		// the model's path for every skill, every run.
		const dir = await skillDir('THE BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		const registered = await registry.register(dir, 'full')

		const loaded = await registry.load('reconcile')

		expect(loaded?.skill).toBe(registered)
	})

	it('re-stamps after a reload, so the NEXT load is a hit again', async () => {
		// A reload that did not re-stamp would leave the file looking changed
		// forever: every subsequent lookup re-reads, and the cache is gone
		// after the first edit rather than after each one.
		const dir = await skillDir('ONE')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		await registry.load('reconcile')

		await rewrite(dir, 'TWO')
		const afterEdit = await registry.load('reconcile')
		const afterThat = await registry.load('reconcile')

		expect(afterEdit?.skill.body).toContain('TWO')
		expect(afterEdit?.skill).toBe(afterThat?.skill)
		// And the object the reload returned is the one the registry now
		// holds — returning one while caching another hands the caller the
		// on-disk name and the registry the registered one.
		expect(afterEdit?.skill).toBe(registry.get('reconcile'))
	})

	it('treats a skill put in by `add` as needing a read', async () => {
		// `add` files a caller-supplied object and takes no stamp — a
		// fire-and-forget `stat` in a synchronous method would race the first
		// `load`. Unstamped means changed, so the first lookup reads the file
		// rather than trusting whatever was handed over.
		const dir = await skillDir('ON DISK')
		const registry = new SkillRegistry(NOOP_LOGGER)
		registry.add('reconcile', {
			metadata: { name: 'reconcile', description: 'd' },
			dirPath: dir,
			body: 'STALE, HANDED IN BY THE CALLER',
		})

		const loaded = await registry.load('reconcile')

		expect(loaded?.skill.body).toContain('ON DISK')
	})

	it('notices an edit that keeps the same size', async () => {
		// Same length, different content. mtime is what catches this one, and
		// it is why the check is not size alone.
		const dir = await skillDir('AAAA')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		await registry.load('reconcile')

		await rewrite(dir, 'BBBB')
		const after = await registry.load('reconcile')

		expect(after?.skill.body).toContain('BBBB')
	})

	it('notices an edit that keeps the same mtime', async () => {
		// The reverse case: a filesystem with coarse timestamps, or a tool
		// that preserves mtime. Size is what catches this one, which is why
		// the check is not mtime alone.
		const dir = await skillDir('SHORT')
		const path = join(dir, 'SKILL.md')
		const frozen = new Date(2020, 0, 1)
		await utimes(path, frozen, frozen)

		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		const before = await registry.load('reconcile')

		await rewrite(dir, 'A MUCH LONGER BODY THAN THE FIRST ONE WAS')
		// Put the mtime back, so mtime alone would say nothing changed.
		await utimes(path, frozen, frozen)
		const after = await registry.load('reconcile')

		expect(before?.skill.body).toContain('SHORT')
		expect(after?.skill.body).toContain('A MUCH LONGER BODY')
	})

	it('keeps the NAMESPACED name a plugin skill was filed under', async () => {
		// The case the re-keying is actually for. A plugin's skills are filed
		// under `plugin__skill` while the file says `skill`, so a reload that
		// took the name off disk would silently un-namespace it — leaving the
		// old key pointing at nothing and minting one nothing in the prompt
		// has heard of.
		//
		// The other rename — an author changing `name:` in the file — cannot
		// happen: the loader validates it against the directory name and
		// refuses. So this is the only way the two can diverge, and it is a
		// deliberate divergence rather than a drift.
		const dir = await skillDir('BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		const { skill } = await (async () => {
			await registry.register(dir)
			const loaded = await registry.load('reconcile')
			if (!loaded) throw new Error('no skill')
			return loaded
		})()
		registry.unregister('reconcile')
		registry.add('ledger__reconcile', {
			...skill,
			metadata: { ...skill.metadata, name: 'ledger__reconcile' },
		})

		await rewrite(dir, 'BODY TWO')
		const after = await registry.load('ledger__reconcile')

		expect(after?.skill.body).toContain('BODY TWO')
		expect(registry.get('ledger__reconcile')?.metadata.name).toBe('ledger__reconcile')
		expect(registry.has('reconcile')).toBe(false)
	})

	it('surfaces an edit that made the file invalid, rather than serving stale', async () => {
		// An author who breaks the frontmatter should hear about it. Quietly
		// keeping the last good body would have the model following
		// instructions from a file that no longer says them.
		const dir = await skillDir('BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		await registry.load('reconcile')

		await rewrite(dir, 'BODY TWO', 'a-different-name')

		await expect(registry.load('reconcile')).rejects.toThrow(/must match directory name/)
	})
})

describe('a deleted skill stops being offered', () => {
	it('drops it rather than serving the last body it had', async () => {
		// Answering with a cached body hands the model instructions for
		// something nobody can point at.
		const dir = await skillDir('BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		await registry.load('reconcile')

		await rm(join(dir, 'SKILL.md'))
		const after = await registry.load('reconcile')

		expect(after).toBeUndefined()
	})

	it('removes it from the listing too, so both agree', async () => {
		// One listing it and the other refusing is the incoherent pair this
		// avoids.
		const dir = await skillDir('BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)
		await registry.load('reconcile')

		await rm(join(dir, 'SKILL.md'))
		await registry.load('reconcile')

		expect(registry.has('reconcile')).toBe(false)
		expect(registry.names()).toEqual([])
	})
})

describe('a metadata-only lookup still notices', () => {
	it('re-reads a changed file even when asked for metadata', async () => {
		// The old short-circuit fired on `level === 'metadata'` regardless of
		// freshness, so a manifest could keep showing a description its author
		// had already rewritten.
		const dir = await skillDir('BODY')
		const registry = new SkillRegistry(NOOP_LOGGER)
		await registry.register(dir)

		await writeFile(
			join(dir, 'SKILL.md'),
			'---\nname: reconcile\ndescription: A COMPLETELY NEW DESCRIPTION\n---\n\nBODY\n',
			'utf-8',
		)
		const after = await registry.load('reconcile', 'metadata')

		expect(after?.skill.metadata.description).toBe('A COMPLETELY NEW DESCRIPTION')
	})
})
