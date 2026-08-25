import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type { Skill } from '../../types/skills/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { SkillRegistry } from '../registry.js'

/**
 * `add` files a skill under the name the CALLER chose, not the one in its
 * own frontmatter.
 *
 * That is the whole reason it exists beside `register(dirPath)`: the plugin
 * path namespaces a plugin's skills so two plugins shipping `reconcile` do
 * not overwrite each other, and the name a skill is filed under is then not
 * the name it declares.
 *
 * Pinned here rather than only through the plugin path, because there the
 * caller also rewrites `metadata.name` to match — so keying off the
 * metadata gives the same answer and the contract is invisible. A caller
 * that passes a different name is the case this protects.
 */

const skill = (name: string): Skill =>
	({
		metadata: { name, description: 'd' },
		dirPath: '/tmp/x',
	}) as Skill

const tempDirs: string[] = []

afterEach(async () => {
	await removeTempDirs(tempDirs)
	tempDirs.length = 0
})

describe('a registry files a skill under the name it was given', () => {
	it('uses the caller’s name, not the frontmatter name', () => {
		const registry = new SkillRegistry(NOOP_LOGGER)

		registry.add('ledger__reconcile', skill('reconcile'))

		expect(registry.has('ledger__reconcile')).toBe(true)
		expect(registry.has('reconcile')).toBe(false)
	})

	it('keeps two skills whose frontmatter names collide', () => {
		// The property the plugin path depends on. Keying off the frontmatter
		// would leave one of these two, with nothing reporting the loss.
		const registry = new SkillRegistry(NOOP_LOGGER)

		registry.add('alpha__reconcile', skill('reconcile'))
		registry.add('beta__reconcile', skill('reconcile'))

		expect(registry.size).toBe(2)
	})

	it('reports whether unregister found anything', () => {
		// A caller undoing a registration needs to be able to tell "removed"
		// from "was never there" — a rollback that reports success for a name
		// it never held is a rollback nobody can trust.
		const registry = new SkillRegistry(NOOP_LOGGER)
		registry.add('a', skill('a'))

		expect(registry.unregister('a')).toBe(true)
		expect(registry.unregister('a')).toBe(false)
		expect(registry.size).toBe(0)
	})

	it('lists the registered name while re-reading edited metadata', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-skill-catalog-'))
		tempDirs.push(root)
		const dir = join(root, 'reconcile')
		const path = join(dir, 'SKILL.md')
		await mkdir(dir)
		await writeFile(path, '---\nname: reconcile\ndescription: before\n---\nbody\n', 'utf8')
		const registry = new SkillRegistry(NOOP_LOGGER)
		const loaded = await registry.register(dir)
		registry.unregister('reconcile')
		registry.add('ledger__reconcile', loaded)

		expect(await registry.catalog()).toEqual([
			{
				registeredName: 'ledger__reconcile',
				description: 'before',
				location: path,
			},
		])

		await writeFile(
			path,
			'---\nname: reconcile\ndescription: after metadata edit\n---\nbody\n',
			'utf8',
		)

		expect(await registry.catalog()).toEqual([
			{
				registeredName: 'ledger__reconcile',
				description: 'after metadata edit',
				location: path,
			},
		])
	})
})
