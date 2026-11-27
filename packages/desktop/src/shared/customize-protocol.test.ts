import { describe, expect, it } from 'vitest'
import {
	readPluginManifestView,
	readSkillCatalog,
	readSkillFileText,
	readSkillFiles,
	withManifestDetails,
} from './customize-protocol.js'

const entry = {
	name: 'a',
	description: 'd',
	tier: 'user',
	place: 'user',
	state: 'on',
	fileCount: 2,
	removable: true,
}

describe('reading the skill catalog', () => {
	it('keeps the known fields, once per name, and drops the rest', () => {
		const view = readSkillCatalog({
			skills: [
				{
					...entry,
					secret: '/home/x',
					plugin: 'p',
					updatedAt: '2026-11-01T00:00:00.000Z',
					lastUsedAt: 'not a time',
					uses7d: 3,
					uses: -1,
				},
				entry,
				{ ...entry, name: '' },
				{ ...entry, name: 'b', state: 'sideways' },
				{ ...entry, name: 'c', place: undefined },
				'x',
			],
		})
		expect(view.skills).toEqual([
			{
				name: 'a',
				description: 'd',
				tier: 'user',
				place: 'user',
				plugin: 'p',
				state: 'on',
				updatedAt: '2026-11-01T00:00:00.000Z',
				fileCount: 2,
				uses7d: 3,
				removable: true,
			},
		])
	})
	it('caps the list, the description and the file count', () => {
		const many = Array.from({ length: 700 }, (_, i) => ({ ...entry, name: `s${i}` }))
		expect(readSkillCatalog({ skills: many }).skills).toHaveLength(500)
		const long = readSkillCatalog({
			skills: [{ ...entry, description: 'x'.repeat(5000), fileCount: 99999 }],
		}).skills[0]
		expect(long?.description).toHaveLength(1024)
		expect(long?.fileCount).toBe(200)
	})
	it('answers an empty list for anything that is not a list', () => {
		expect(readSkillCatalog(undefined)).toEqual({ skills: [] })
		expect(readSkillCatalog({ skills: 'a' })).toEqual({ skills: [] })
	})
})

describe('reading a skill’s files', () => {
	it('keeps relative paths with sizes, at most 200, and drops paths that leave the folder', () => {
		const files = readSkillFiles({
			files: [
				{ path: 'a.md', size: 1, extra: 1 },
				{ path: '../x', size: 1 },
				{ path: '/etc/passwd', size: 1 },
				{ path: 'a/../../b', size: 1 },
				{ path: 'n\0', size: 1 },
				{ path: 'ok/b.txt', size: -1 },
				{ path: 'ok/c.txt', size: 4 },
			],
		})
		expect(files).toEqual({
			files: [
				{ path: 'a.md', size: 1 },
				{ path: 'ok/c.txt', size: 4 },
			],
		})
		const many = Array.from({ length: 300 }, (_, i) => ({ path: `f${i}`, size: 1 }))
		expect(readSkillFiles({ files: many }).files).toHaveLength(200)
	})
})

describe('reading a skill’s file text', () => {
	it('takes a text and a truncated flag, cut at 256 KiB, or nothing', () => {
		expect(readSkillFileText({ text: 'hi', truncated: false })).toEqual({
			text: 'hi',
			truncated: false,
		})
		expect(readSkillFileText({ text: 'x'.repeat(300_000), truncated: true })?.text).toHaveLength(
			256 * 1024,
		)
		expect(readSkillFileText({ text: 'hi' })).toBeNull()
		expect(readSkillFileText(null)).toBeNull()
	})
})

describe('reading a plugin’s manifest fields', () => {
	it('keeps skills, servers, author and time, and nothing else', () => {
		expect(
			readPluginManifestView({
				name: 'p',
				skills: [{ name: 'p__a', description: 'd', path: '/x' }, { name: '' }, 4],
				servers: [{ name: 'notes', env: { K: 'v' } }, {}],
				author: 'Someone',
				updatedAt: '2026-11-01T00:00:00.000Z',
			}),
		).toEqual({
			skills: [{ name: 'p__a', description: 'd' }],
			servers: [{ name: 'notes' }],
			author: 'Someone',
			updatedAt: '2026-11-01T00:00:00.000Z',
		})
		expect(readPluginManifestView({ updatedAt: 'x', author: '' })).toEqual({})
		expect(readPluginManifestView('x')).toEqual({})
	})
	it('cleans each plugin of an inventory and leaves its other fields alone', () => {
		const view = withManifestDetails({
			live: false,
			plugins: [{ name: 'p', version: '1', skills: 'bad', author: 'A', servers: [{ name: 's' }] }],
		})
		expect(view).toEqual({
			live: false,
			plugins: [{ name: 'p', version: '1', author: 'A', servers: [{ name: 's' }] }],
		})
	})
})
